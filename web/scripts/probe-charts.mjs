// Probe of what charts rely on in the spreadsheet engine: a hidden sheet that
// holds chart definitions, and range references that the engine keeps true
// when rows move. Run: node scripts/probe-charts.mjs
import { readFileSync } from 'node:fs'
import { initSync, Model } from '@ironcalc/wasm-xlsx'

initSync({ module: readFileSync(new URL('../node_modules/@ironcalc/wasm-xlsx/wasm_bg.wasm', import.meta.url)) })

const a = new Model('Book', 'en', 'UTC', 'en')
const b = Model.fromBytes(a.toBytes(), 'en')
a.setUserInput(0, 1, 1, 'Item')
a.setUserInput(0, 1, 2, 'Cost')
a.setUserInput(0, 2, 1, 'Laptops')
a.setUserInput(0, 2, 2, '4200')
a.setUserInput(0, 3, 1, 'Chairs')
a.setUserInput(0, 3, 2, '=B2/2')
a.updateRangeStyle({ sheet: 0, row: 2, column: 2, width: 1, height: 2 }, 'num_fmt', '"€"#,##0.00')

a.newSheet()
const i = a.getWorksheetsProperties().length - 1
try { a.renameSheet(i, '_charts_ab12') } catch (e) { console.log('rename failed:', String(e)) }
a.hideSheet(i)
console.log('sheets:', JSON.stringify(a.getWorksheetsProperties()))
a.setUserInput(i, 1, 1, 'opensuite:charts')
a.setUserInput(i, 7, 1, 'abc123')
a.setUserInput(i, 7, 2, JSON.stringify({ type: 'column', title: 'Costs "quoted"', x: 120, y: 80 }))
a.setUserInput(i, 7, 3, "=Sheet1!A1:B3")
console.log('range cell content:', a.getCellContent(i, 7, 3), '| value:', a.getFormattedCellValue(i, 7, 3))
console.log('json cell content:', a.getCellContent(i, 7, 2))
console.log('selected sheet after edits:', a.getSelectedSheet())
const diff = a.flushSendQueue()
b.applyExternalDiffs(diff)
console.log('replica sheets:', JSON.stringify(b.getWorksheetsProperties()), '| replica range:', b.getCellContent(i, 7, 3))

a.insertRows(0, 2, 2)
console.log('after inserting 2 rows at 2:', a.getCellContent(i, 7, 3))
a.insertColumns(0, 1, 1)
console.log('after inserting a column at A:', a.getCellContent(i, 7, 3))
a.renameSheet(0, 'Budget 2026')
console.log('after renaming the data sheet:', a.getCellContent(i, 7, 3))
a.deleteRows(0, 1, 6)
console.log('after deleting the rows it covers:', a.getCellContent(i, 7, 3))
a.undo()
console.log('after undo:', a.getCellContent(i, 7, 3), '| canUndo', a.canUndo())
console.log('formatted values:', a.getFormattedCellValue(0, 4, 3), a.getFormattedCellValue(0, 5, 3), '| types:', a.getCellType(0, 4, 3), a.getCellType(0, 4, 2), '| fmt:', a.getCellStyle(0, 4, 3).style.num_fmt)
console.log('rows with data in charts col A:', Array.from(a.getRowsWithData(i, 1)))
a.setUserInput(i, 7, 1, '')
console.log('rows after clearing id:', Array.from(a.getRowsWithData(i, 1)))
a.rangeClearAll(i, 7, 1, 7, 3)
console.log('rows after clearAll:', Array.from(a.getRowsWithData(i, 1)))
const x = Model.fromBytes(a.toBytes(), 'en')
x.deleteSheet(i)
console.log('export copy sheets:', x.getWorksheetsProperties().map((s) => s.name), '| xlsx bytes', x.toXlsx().length)
a.setUserInput(0, 20, 1, '12/03/2026')
a.setUserInput(0, 20, 2, '45%')
a.setUserInput(0, 20, 3, '-1234.5')
a.setUserInput(0, 20, 4, 'TRUE')
console.log('date:', a.getFormattedCellValue(0, 20, 1), a.getCellType(0, 20, 1), a.getCellStyle(0, 20, 1).style.num_fmt, '| pct:', a.getFormattedCellValue(0, 20, 2), a.getCellStyle(0, 20, 2).style.num_fmt, '| neg:', a.getFormattedCellValue(0, 20, 3), '| bool:', a.getFormattedCellValue(0, 20, 4), a.getCellType(0, 20, 4))
