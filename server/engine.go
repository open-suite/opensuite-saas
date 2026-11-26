package main

// The content engine: the app's own document code (Yjs and the editor's
// schema, the spreadsheet engine, the presentation model, the calendar's
// invitation writer) running headless in Node, built from web/src/headless
// into one script. The server still never parses a document itself; when the
// API has to read or change content, it hands the engine the document's
// state and gets back text, or an update in the same form a browser would
// have sent, which then goes through the ordinary sync path and merges with
// whoever is editing live.
//
// Like pandoc, it is a tool, not a service: started on the first request,
// kept while requests keep coming, and stopped after a quiet spell. Requests
// are answered one at a time over stdin and stdout, one JSON object a line.
// While working the engine may ask for something (a picture, or a place to
// store one) and waits for the answer.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

const (
	engineIdle    = 3 * time.Minute
	engineTimeout = 90 * time.Second
)

// engineError is the engine refusing a request for a reason a person can
// act on ("that quote is not in the document"), as opposed to failing.
type engineError string

func (e engineError) Error() string { return string(e) }

var errEngineDown = errors.New("the content engine is not available")

type engineLine struct {
	ID    int             `json:"id"`
	OK    json.RawMessage `json:"ok"`
	Error *string         `json:"error"`
	Call  string          `json:"call"`
	Args  json.RawMessage `json:"args"`
}

type contentEngine struct {
	node, script string

	mu    sync.Mutex // one request at a time
	cmd   *exec.Cmd
	in    io.WriteCloser
	lines chan []byte
	seq   int
	idle  *time.Timer
}

func newContentEngine(cfg Config) *contentEngine {
	script, _ := filepath.Abs(env("OS_ENGINE", filepath.Join(filepath.Dir(cfg.WebDir), "dist-headless", "engine.mjs")))
	return &contentEngine{node: env("OS_NODE", "node"), script: script}
}

func (e *contentEngine) start() error {
	if _, err := os.Stat(e.script); err != nil {
		return errEngineDown
	}
	cmd := exec.Command(e.node, "--max-old-space-size=1024", e.script)
	cmd.Dir = filepath.Dir(e.script)
	cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + os.TempDir(), "LANG=C.UTF-8", "NODE_ENV=production"}
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		log.Printf("engine: %v", err)
		return errEngineDown
	}
	lines := make(chan []byte, 4)
	go func() {
		rd := bufio.NewReaderSize(out, 1<<20)
		for {
			b, err := rd.ReadBytes('\n')
			if len(b) > 0 {
				lines <- b
			}
			if err != nil {
				close(lines)
				return
			}
		}
	}()
	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			log.Printf("engine: %s", sc.Text())
		}
	}()
	go cmd.Wait()
	e.cmd, e.in, e.lines = cmd, in, lines
	return nil
}

// stop ends the process; the next request starts a fresh one.
func (e *contentEngine) stop() {
	if e.cmd == nil {
		return
	}
	e.in.Close()
	e.cmd.Process.Kill()
	e.cmd, e.in, e.lines = nil, nil, nil
}

// run sends one request and waits for its answer, serving the engine's
// questions on the way through answer.
func (e *contentEngine) run(ctx context.Context, op string, args any, answer func(call string, args json.RawMessage) any) (json.RawMessage, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.idle != nil {
		e.idle.Stop()
	}
	defer func() {
		e.idle = time.AfterFunc(engineIdle, func() {
			e.mu.Lock()
			defer e.mu.Unlock()
			e.stop()
		})
	}()
	if e.cmd == nil {
		if err := e.start(); err != nil {
			return nil, err
		}
	}
	e.seq++
	id := e.seq
	send := func(v any) error {
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = e.in.Write(append(b, '\n'))
		return err
	}
	if err := send(map[string]any{"id": id, "op": op, "args": args}); err != nil {
		e.stop()
		return nil, errEngineDown
	}
	ctx, cancel := context.WithTimeout(ctx, engineTimeout)
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			// It may be stuck on a hostile file; a new process is cheap.
			e.stop()
			return nil, engineError("That took too long to process.")
		case b, open := <-e.lines:
			if !open {
				e.stop()
				return nil, errEngineDown
			}
			var line engineLine
			if json.Unmarshal(b, &line) != nil || line.ID != id {
				continue
			}
			switch {
			case line.Call != "":
				if err := send(map[string]any{"id": id, "reply": answer(line.Call, line.Args)}); err != nil {
					e.stop()
					return nil, errEngineDown
				}
			case line.Error != nil:
				return nil, engineError(*line.Error)
			default:
				return line.OK, nil
			}
		}
	}
}
