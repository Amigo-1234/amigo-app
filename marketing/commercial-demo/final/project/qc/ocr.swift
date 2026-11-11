// On-device OCR (macOS Vision) over a folder of frame PNGs. Prints "<file>\t<text | text | ...>".
import Foundation
import Vision
import AppKit
let dir = CommandLine.arguments[1]
let files = try FileManager.default.contentsOfDirectory(atPath: dir).filter { $0.hasSuffix(".png") }.sorted()
for f in files {
  guard let img = NSImage(contentsOfFile: "\(dir)/\(f)"), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
  let req = VNRecognizeTextRequest(); req.recognitionLevel = .accurate; req.usesLanguageCorrection = false
  try VNImageRequestHandler(cgImage: cg).perform([req])
  let text = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " | ")
  print("\(f)\t\(text)")
}
