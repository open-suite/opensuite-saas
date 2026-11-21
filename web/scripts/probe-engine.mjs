// Probe of the spreadsheet engine's behaviour, kept as an executable record of
// the assumptions sheet.jsx relies on. Run: node scripts/probe-engine.mjs
import { readFileSync } from 'node:fs'
import { initSync, Model } from '@ironcalc/wasm-xlsx'

initSync({ module: readFileSync(new URL('../node_modules/@ironcalc/wasm-xlsx/wasm_bg.wasm', import.meta.url)) })

const a = new Model('Sheet', 'en', 'UTC', 'en')
const b = Model.fromBytes(a.toBytes(), 'en')
console.log('empty queue bytes:', a.flushSendQueue().length)

a.setUserInput(0, 1, 1, '21')
a.setUserInput(0, 1, 2, '=A1*2')
console.log('B1 =', a.getFormattedCellValue(0, 1, 2), '| content:', a.getCellContent(0, 1, 2))
const diff = a.flushSendQueue()
console.log('diff bytes:', diff.length, '| queue after flush:', a.flushSendQueue().length)

b.applyExternalDiffs(diff)
console.log('replica B1 =', b.getFormattedCellValue(0, 1, 2), '| replica queue after external:', b.flushSendQueue().length, '| replica canUndo:', b.canUndo())

console.log('col width:', a.getColumnWidth(0, 1), 'row height:', a.getRowHeight(0, 1))
a.setSelectedCell(1, 1)
console.log('queue after selection:', a.flushSendQueue().length)
console.log('view:', JSON.stringify(a.getSelectedView()))
a.updateRangeStyle({ sheet: 0, row: 1, column: 1, width: 1, height: 1 }, 'font.b', 'true')
a.updateRangeStyle({ sheet: 0, row: 1, column: 1, width: 1, height: 1 }, 'fill.color', '#ffcc00')
a.updateRangeStyle({ sheet: 0, row: 1, column: 1, width: 1, height: 1 }, 'num_fmt', '0.00')
const st = a.getCellStyle(0, 1, 1)
console.log('style:', JSON.stringify(st))
console.log('fill resolved:', a.resolveColor(st.style.fill.color), '| font colour resolved:', a.resolveColor(st.style.font.color))
console.log('formatted A1:', a.getFormattedCellValue(0, 1, 1))
a.setSelectedRange(1, 1, 1, 2)
const clip = a.copyToClipboard()
console.log('clipboard csv:', JSON.stringify(clip.csv), '| range:', JSON.stringify(clip.range), '| data type:', clip.data?.constructor?.name)
a.setSelectedCell(3, 1)
a.pasteFromClipboard(0, clip.range, clip.data, false)
console.log('A3/B3 after paste:', a.getFormattedCellValue(0, 3, 1), a.getFormattedCellValue(0, 3, 2), a.getCellContent(0, 3, 2))
a.setSelectedCell(5, 1) // pasteCsvText requires the selected cell to be inside the area
a.pasteCsvText({ sheet: 0, row: 5, column: 1, width: 1, height: 1 }, 'x\ty\n1\t2')
console.log('csv paste A5,B6:', a.getFormattedCellValue(0, 5, 1), a.getFormattedCellValue(0, 6, 2))
console.log('sheets:', JSON.stringify(a.getWorksheetsProperties()))
console.log('rows with data in col A:', Array.from(a.getRowsWithData(0, 1)), '| cols with data in row 1:', Array.from(a.getColumnsWithData(0, 1)))
a.insertRows(0, 1, 1)
console.log('after insert row: B2 content', a.getCellContent(0, 2, 2), '| merged:', JSON.stringify(a.getMergedCells(0)))
console.log('undo ok:', a.canUndo(), '| frozen rows:', a.getFrozenRowsCount(0), '| grid lines:', a.getShowGridLines(0))
const x = a.toXlsx()
const c = Model.fromXlsx(x, 'Book', 'en', 'UTC', 'en')
console.log('xlsx bytes:', x.length, '| round trip B2:', c.getFormattedCellValue(0, 2, 2), '| bytes:', a.toBytes().length)
console.log('type of A2:', a.getCellType(0, 2, 1), '| error cell:', (a.setUserInput(0, 9, 1, '=1/0'), a.getFormattedCellValue(0, 9, 1)))
