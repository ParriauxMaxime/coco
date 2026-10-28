// Draws coco's parrot on a rounded tile: swift scripts/icon.swift <out.png> <size> [template]
import AppKit

let args = CommandLine.arguments
let out = args[1]
let size = CGFloat(Double(args[2]) ?? 1024)
let template = args.count > 3

let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
if !template {
  let inset = size * 0.1
  let tile = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
  NSColor(calibratedRed: 0.11, green: 0.12, blue: 0.16, alpha: 1).setFill()
  NSBezierPath(roundedRect: tile, xRadius: tile.width * 0.22, yRadius: tile.width * 0.22).fill()
}
let glyph = "🦜" as NSString
let font = NSFont(name: "Apple Color Emoji", size: size * (template ? 0.8 : 0.55))!
let attrs: [NSAttributedString.Key: Any] = [.font: font]
let measured = glyph.size(withAttributes: attrs)
glyph.draw(at: NSPoint(x: (size - measured.width) / 2, y: (size - measured.height) / 2), withAttributes: attrs)
image.unlockFocus()

let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
