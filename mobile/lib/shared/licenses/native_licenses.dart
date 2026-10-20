import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

const _channel = MethodChannel('buzz/native_licenses');
bool _registered = false;

/// Add the native build's notices to Flutter's existing Dart/asset notices.
void registerNativeLicenses() {
  if (_registered) return;
  _registered = true;
  LicenseRegistry.addLicense(() => loadNativeLicenseEntries());
}

Stream<LicenseEntry> loadNativeLicenseEntries({
  TargetPlatform? platform,
  MethodChannel channel = _channel,
  void Function(FlutterErrorDetails) reportError = FlutterError.reportError,
}) async* {
  final target = platform ?? defaultTargetPlatform;
  if (kIsWeb ||
      (target != TargetPlatform.android && target != TargetPlatform.iOS)) {
    return;
  }
  try {
    final result = await channel.invokeMethod<Object?>('load');
    if (result is! List || result.isEmpty) {
      throw const FormatException('The native notice bundle is empty');
    }
    // Validate the complete payload first; never display a partial success.
    final entries = <LicenseEntry>[];
    for (final entry in result) {
      if (entry is! Map ||
          entry['name'] is! String ||
          entry['text'] is! String ||
          (entry['name'] as String).trim().isEmpty ||
          (entry['text'] as String).trim().isEmpty) {
        throw const FormatException('A native notice has no identity or text');
      }
      entries.add(
        LicenseEntryWithLineBreaks([
          entry['name'] as String,
        ], entry['text'] as String),
      );
    }
    yield* Stream.fromIterable(entries);
  } catch (error, stack) {
    reportError(
      FlutterErrorDetails(
        exception: error,
        stack: stack,
        library: 'Buzz native dependency notices',
      ),
    );
    yield LicenseEntryWithLineBreaks(
      const ['Native dependency notices unavailable'],
      'The native dependency notices could not be loaded for this build. '
      'The other entries on this screen cover Flutter packages and bundled '
      'assets only. Please report this missing notice bundle to your '
      'Buzz administrator.',
    );
  }
}
