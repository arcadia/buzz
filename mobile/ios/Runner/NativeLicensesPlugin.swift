import Flutter
import Foundation

/// CocoaPods notices are checked against Podfile.lock and copied by the build phase.
final class NativeLicensesPlugin {
  private let channel: FlutterMethodChannel

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "buzz/native_licenses", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "load" else {
        result(FlutterMethodNotImplemented)
        return
      }
      do {
        guard let url = Bundle.main.url(forResource: "native-licenses", withExtension: "json"),
          let document = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
            as? [String: Any],
          let entries = document["entries"] as? [[String: String]],
          !entries.isEmpty,
          entries.allSatisfy({
            !($0["name"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              && !($0["text"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          })
        else {
          result(FlutterError(code: "native_notices_unavailable",
                              message: "Missing or incomplete CocoaPods notices", details: nil))
          return
        }
        result(entries)
      } catch {
        result(FlutterError(code: "native_notices_unavailable",
                            message: "Cannot read bundled CocoaPods notices", details: nil))
      }
    }
  }
}
