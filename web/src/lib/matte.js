// The picture pipeline behind call backgrounds. For every camera frame:
//
//   1. a small model says, per pixel of a 256-pixel picture, how sure it is
//      that the pixel belongs to a person (a soft value, not yes or no);
//   2. that value is steadied against the previous frame, so edges the model
//      is unsure about do not flicker;
//   3. it is brought up to the camera's resolution by a joint bilateral
//      filter, which follows the real edges in the camera picture (hair,
//      ears, shoulders) instead of the model's coarse squares. This step is
//      what makes the outline smooth rather than stepped;
//   4. the background is blurred (ignoring the person, so they do not smear
//      into it) or replaced, and the two are blended along the soft edge.
//
// All of it runs on the graphics card, in the WebGL2 context the model
// itself uses, so the model's answer never has to be copied back to memory.
// The class is a frame transformer for @livekit/track-processors'
// ProcessorWrapper, which owns the camera stream plumbing.
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'

const VERT = `#version 300 es
in vec2 p;
uniform float flip; // 1 when drawing to the canvas, whose first row is at the top
out vec2 uv;
void main() {
  uv = p * 0.5 + 0.5;
  if (flip > 0.5) uv.y = 1.0 - uv.y;
  gl_Position = vec4(p, 0.0, 1.0);
}`

// Step 2. Where the model is sure, follow it at once; where it is not, lean
// on the last frame.
const STEADY = `#version 300 es
precision highp float;
uniform sampler2D seg;
uniform sampler2D prev;
uniform float person; // 1: seg is "person", 0: seg is "background"
uniform float fresh;  // 1 on the first frame, when there is no last frame
in vec2 uv;
out vec4 o;
void main() {
  float c = texture(seg, uv).r;
  c = mix(1.0 - c, c, person);
  float was = texture(prev, uv).r;
  float sure = abs(c - 0.5) * 2.0;
  float lean = (1.0 - sure * sure) * 0.75 * (1.0 - fresh);
  o = vec4(vec3(mix(c, was, lean)), 1.0);
}`

// Step 3. Each output pixel takes the mask from its neighbourhood, trusting
// neighbours more the closer they are and the more their colour in the
// camera picture matches its own. Colour differences are where real edges
// are, so the mask's edge moves onto them.
const REFINE = `#version 300 es
precision highp float;
uniform sampler2D frame;
uniform sampler2D mask;
uniform vec2 px;      // one output pixel
uniform float reach;  // kernel radius in output pixels
uniform float stride; // distance between taps
uniform float sigmaSpace;
uniform float sigmaColor;
in vec2 uv;
out vec4 o;
float bell(float x, float sigma) { return exp(-0.5 * x * x / (sigma * sigma)); }
void main() {
  vec3 here = texture(frame, uv).rgb;
  float sum = 0.0;
  float weight = 0.0;
  for (float y = -reach; y <= reach; y += stride) {
    for (float x = -reach; x <= reach; x += stride) {
      vec2 at = uv + vec2(x, y) * px;
      float w = bell(length(vec2(x, y)), sigmaSpace) * bell(distance(here, texture(frame, at).rgb), sigmaColor);
      sum += texture(mask, at).r * w;
      weight += w;
    }
  }
  o = vec4(vec3(sum / max(weight, 1e-5)), 1.0);
}`

// Step 4a. One direction of a Gaussian blur that counts only background
// pixels, so the person's colours never bleed into the blur. Alpha carries
// how much background was found, for the second direction to use.
const BLUR = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform sampler2D mask;
uniform vec2 dir;    // one texel along the blur direction
uniform float sigma; // in texels of the blur buffer
uniform float first; // 1: src is the camera frame, weigh by the mask; 0: src is the first direction's result, weigh by its alpha
in vec2 uv;
out vec4 o;
void main() {
  vec3 sum = vec3(0.0);
  float weight = 0.0;
  float all = 0.0;
  float reach = ceil(sigma * 2.5);
  for (float i = -reach; i <= reach; i += 1.0) {
    vec2 at = uv + dir * i;
    float g = exp(-0.5 * i * i / (sigma * sigma));
    vec4 s = texture(src, at);
    float bg = first > 0.5 ? 1.0 - smoothstep(0.25, 0.6, texture(mask, at).r) : s.a;
    sum += s.rgb * g * bg;
    weight += g * bg;
    all += g;
  }
  // Nothing but person nearby: fall back to the plain picture rather than black.
  o = weight > 1e-4 ? vec4(sum / weight, weight / all) : vec4(texture(src, uv).rgb, 0.0);
}`

// Step 4b. The blend.
const BLEND = `#version 300 es
precision highp float;
uniform sampler2D frame;
uniform sampler2D mask;
uniform sampler2D back;
uniform vec4 backFit; // scale.xy, offset.xy: fits the background picture over the frame, cropping
uniform vec2 edge;    // the mask values where the person starts and is fully there
in vec2 uv;
out vec4 o;
void main() {
  float a = smoothstep(edge.x, edge.y, texture(mask, uv).r);
  vec3 person = texture(frame, uv).rgb;
  vec3 behind = texture(back, uv * backFit.xy + backFit.zw).rgb;
  o = vec4(mix(behind, person, a), 1.0);
}`

const MASK = 256 // the model's own size
const SHRINK = 4 // the blur works on a quarter-size picture
const FINE = 2 // the refined mask is half the frame's size; the blend smooths it the rest of the way

export class Matte {
  // opts: { runtime, model, mode, onFrame(ms, segmentMs), onFail() }
  // mode: { kind: 'blur', strength: px } | { kind: 'image', url }
  constructor(opts) {
    this.opts = opts
    this.mode = opts.mode
    this.errors = 0
    this.count = 0
    this.light = false
  }

  async init({ outputCanvas }) {
    this.canvas = outputCanvas
    this.transformer = new TransformStream({ transform: (frame, controller) => this.transform(frame, controller) })
    const files = await FilesetResolver.forVisionTasks(this.opts.runtime)
    this.segmenter = await ImageSegmenter.createFromOptions(files, {
      baseOptions: { modelAssetPath: this.opts.model, delegate: 'GPU' },
      canvas: this.canvas,
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    })
    // The model gives one confidence picture per label. If one of them is the
    // background, the person is everything else; otherwise the first is the person.
    const labels = this.segmenter.getLabels()
    const background = labels.findIndex((l) => /background/i.test(l))
    this.personIndex = Math.max(0, background)
    this.personIs = background >= 0 ? 0 : 1
    const gl = (this.gl = this.canvas.getContext('webgl2'))
    if (!gl) throw new Error('no WebGL2')
    this.build(gl)
    this.fresh = true
    this.w = this.h = 0
    await this.setMode(this.mode)
  }

  async restart(opts) {
    await this.destroy()
    await this.init(opts)
  }

  async update(mode) {
    await this.setMode(mode)
  }

  async setMode(mode) {
    if (mode.kind === 'image' && mode.url !== this.backUrl) {
      const img = new Image()
      img.src = mode.url
      await img.decode()
      const bitmap = await createImageBitmap(img)
      const gl = this.gl
      if (!gl) return bitmap.close()
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.tex.back)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
      this.backSize = [bitmap.width, bitmap.height]
      this.backUrl = mode.url
      bitmap.close()
    }
    this.mode = mode
  }

  async destroy() {
    const { gl, segmenter } = this
    this.gl = this.segmenter = null
    try {
      segmenter?.close()
    } catch {}
    if (gl) {
      for (const t of Object.values(this.tex || {})) gl.deleteTexture(t)
      for (const f of Object.values(this.fbo || {})) gl.deleteFramebuffer(f)
      for (const p of Object.values(this.prog || {})) gl.deleteProgram(p.id)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    this.backUrl = null
  }

  // --- setting up ---------------------------------------------------------

  build(gl) {
    const compile = (type, src) => {
      const s = gl.createShader(type)
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s))
      return s
    }
    const vert = compile(gl.VERTEX_SHADER, VERT)
    const program = (frag) => {
      const id = gl.createProgram()
      gl.attachShader(id, vert)
      gl.attachShader(id, compile(gl.FRAGMENT_SHADER, frag))
      gl.bindAttribLocation(id, 0, 'p')
      gl.linkProgram(id)
      if (!gl.getProgramParameter(id, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(id))
      const u = {}
      for (let i = 0; i < gl.getProgramParameter(id, gl.ACTIVE_UNIFORMS); i++) {
        const name = gl.getActiveUniform(id, i).name
        u[name] = gl.getUniformLocation(id, name)
      }
      return { id, u }
    }
    this.prog = { steady: program(STEADY), refine: program(REFINE), blur: program(BLUR), blend: program(BLEND) }
    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    this.quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    const texture = () => {
      const t = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return t
    }
    this.tex = { frame: texture(), back: texture(), maskA: texture(), maskB: texture(), fine: texture(), blurA: texture(), blurB: texture() }
    this.fbo = {}
    for (const name of ['maskA', 'maskB', 'fine', 'blurA', 'blurB']) this.fbo[name] = gl.createFramebuffer()
    this.size('maskA', MASK, MASK)
    this.size('maskB', MASK, MASK)
    this.backSize = [1, 1]
    gl.bindTexture(gl.TEXTURE_2D, this.tex.back)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 28, 38, 255]))
    this.steady = ['maskA', 'maskB'] // [last frame's, this frame's]
  }

  size(name, w, h) {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.tex[name])
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[name])
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex[name], 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  // --- every frame --------------------------------------------------------

  transform(frame, controller) {
    const started = performance.now()
    try {
      if (!this.gl || !this.segmenter || !frame.displayWidth) return
      const w = frame.displayWidth
      const h = frame.displayHeight
      if (w !== this.w || h !== this.h) {
        this.canvas.width = this.w = w
        this.canvas.height = this.h = h
        this.size('fine', Math.ceil(w / FINE), Math.ceil(h / FINE))
        this.size('blurA', Math.ceil(w / SHRINK), Math.ceil(h / SHRINK))
        this.size('blurB', Math.ceil(w / SHRINK), Math.ceil(h / SHRINK))
        this.fresh = true
      }
      let segmentMs = 0
      this.count++
      if (this.light && this.count % 2 && !this.fresh) {
        // Light mode: every other frame reuses the last answer. The edge
        // still follows this frame's picture, so it does not lag.
        this.draw(frame, null, w, h)
      } else {
        // The model answers inside this call; its picture is only valid
        // until the callback returns, so the whole frame is drawn in there.
        this.segmenter.segmentForVideo(frame, started, (result) => {
          segmentMs = performance.now() - started
          const mask = result.confidenceMasks?.[this.personIndex]
          if (mask) this.draw(frame, mask.getAsWebGLTexture(), w, h)
        })
      }
      controller.enqueue(new VideoFrame(this.canvas, { timestamp: frame.timestamp, alpha: 'discard' }))
      this.errors = 0
      this.pace(started)
      this.opts.onFrame?.(performance.now() - started, segmentMs, this.light)
    } catch (e) {
      // A frame that cannot be drawn is dropped, never sent as it came from
      // the camera. If it keeps happening the caller is told.
      if (++this.errors === 1) console.warn('backdrop frame', e)
      if (this.errors === 45) this.opts.onFail?.(e)
    } finally {
      frame.close()
    }
  }

  // pace watches how many frames a second actually get through. The graphics
  // card works after transform() returns, so time spent here says little;
  // falling behind the camera is what shows a slow one. Two slow stretches
  // in a row switch to light mode, which halves the model's work.
  pace(now) {
    this.window ??= { from: now, frames: 0, slow: 0 }
    const win = this.window
    win.frames++
    if (now - win.from < 2000) return
    const rate = (win.frames * 1000) / (now - win.from)
    const want = this.opts.rate || 30
    win.slow = rate < want * 0.8 ? win.slow + 1 : 0
    if (win.slow >= 2 && !this.light) this.light = true
    win.from = now
    win.frames = 0
  }

  draw(frame, seg, w, h) {
    const gl = this.gl
    const { prog, tex, fbo } = this
    // The model leaves the context in its own state; set everything we rely on.
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.STENCIL_TEST)
    gl.colorMask(true, true, true, true)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.bindVertexArray(this.vao)
    const bind = (unit, texture) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, texture)
    }
    const pass = (p, target, tw, th) => {
      gl.useProgram(p.id)
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? fbo[target] : null)
      gl.viewport(0, 0, tw, th)
      gl.uniform1f(p.u.flip, target ? 0 : 1)
    }
    const run = () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    bind(0, tex.frame)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)

    // 2. steady the model's answer against the last frame (skipped when
    // there is no new answer: the last steadied one is used again)
    if (seg) {
      const [last, now] = this.steady
      bind(1, seg)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST) // it is a float picture; this always works
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      bind(2, tex[last])
      pass(prog.steady, now, MASK, MASK)
      gl.uniform1i(prog.steady.u.seg, 1)
      gl.uniform1i(prog.steady.u.prev, 2)
      gl.uniform1f(prog.steady.u.person, this.personIs)
      gl.uniform1f(prog.steady.u.fresh, this.fresh ? 1 : 0)
      run()
      this.steady = [now, last]
      this.fresh = false
    }

    // 3. bring it up to camera resolution along the picture's own edges
    const fw = Math.ceil(w / FINE)
    const fh = Math.ceil(h / FINE)
    const grain = Math.max(fw, fh) / MASK // refined pixels per mask pixel
    bind(1, tex[this.steady[0]])
    pass(prog.refine, 'fine', fw, fh)
    gl.uniform1i(prog.refine.u.frame, 0)
    gl.uniform1i(prog.refine.u.mask, 1)
    gl.uniform2f(prog.refine.u.px, 1 / fw, 1 / fh)
    gl.uniform1f(prog.refine.u.reach, grain * 1.6)
    gl.uniform1f(prog.refine.u.stride, grain * 0.4)
    gl.uniform1f(prog.refine.u.sigmaSpace, grain * 0.9)
    gl.uniform1f(prog.refine.u.sigmaColor, 0.1)
    run()

    // 4. the background
    let back = tex.back
    let fit = [1, 1, 0, 0]
    let edge = [0.5, 0.8] // strict: against a new picture, a half-sure pixel of the old room shows
    if (this.mode.kind === 'blur') {
      const bw = Math.ceil(w / SHRINK)
      const bh = Math.ceil(h / SHRINK)
      const sigma = Math.max(1, this.mode.strength / SHRINK)
      bind(1, tex.fine)
      gl.useProgram(prog.blur.id)
      gl.uniform1i(prog.blur.u.mask, 1)
      gl.uniform1f(prog.blur.u.sigma, sigma)
      bind(2, tex.frame)
      pass(prog.blur, 'blurA', bw, bh)
      gl.uniform1i(prog.blur.u.src, 2)
      gl.uniform2f(prog.blur.u.dir, 1 / bw, 0)
      gl.uniform1f(prog.blur.u.first, 1)
      run()
      bind(2, tex.blurA)
      pass(prog.blur, 'blurB', bw, bh)
      gl.uniform2f(prog.blur.u.dir, 0, 1 / bh)
      gl.uniform1f(prog.blur.u.first, 0)
      run()
      back = tex.blurB
      edge = [0.45, 0.75] // a blurred version of the same room forgives a slightly wider edge
    } else {
      // Fit the picture over the frame, cropping what does not fit.
      const [iw, ih] = this.backSize
      const sx = Math.min(1, (w / h) / (iw / ih))
      const sy = Math.min(1, (iw / ih) / (w / h))
      fit = [sx, sy, (1 - sx) / 2, (1 - sy) / 2]
    }
    bind(1, tex.fine)
    bind(2, back)
    pass(prog.blend, null, w, h)
    gl.uniform1i(prog.blend.u.frame, 0)
    gl.uniform1i(prog.blend.u.mask, 1)
    gl.uniform1i(prog.blend.u.back, 2)
    gl.uniform4f(prog.blend.u.backFit, ...fit)
    gl.uniform2f(prog.blend.u.edge, ...edge)
    run()

    gl.bindVertexArray(null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.useProgram(null)
    gl.activeTexture(gl.TEXTURE0)
  }
}
