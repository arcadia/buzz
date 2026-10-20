import 'package:buzz/shared/licenses/native_licenses.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('buzz/native_licenses');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test(
    'native dependency identity and full text reach the Flutter viewer',
    () async {
      messenger.setMockMethodCallHandler(channel, (call) async {
        expect(call.method, 'load');
        return [
          {
            'name': 'Example Native SDK 1.2.3',
            'text': 'Copyright Example Authors\n\nFull license text',
          },
        ];
      });
      for (final platform in [TargetPlatform.android, TargetPlatform.iOS]) {
        final entries = await loadNativeLicenseEntries(
          platform: platform,
        ).toList();
        expect(entries.single.packages.single, 'Example Native SDK 1.2.3');
        expect(entries.single.paragraphs.map((paragraph) => paragraph.text), [
          'Copyright Example Authors',
          'Full license text',
        ]);
      }
    },
  );

  test('nonmobile targets do not invoke a missing native plugin', () async {
    messenger.setMockMethodCallHandler(
      channel,
      (_) async => throw StateError('must not invoke'),
    );
    expect(
      await loadNativeLicenseEntries(platform: TargetPlatform.windows).toList(),
      isEmpty,
    );
  });

  for (final response in [
    null,
    <Object>[],
    [
      {'name': 'SDK', 'text': ''},
    ],
  ]) {
    test(
      'an invalid native bundle is visible instead of silently omitted: $response',
      () async {
        messenger.setMockMethodCallHandler(channel, (_) async => response);
        final errors = <FlutterErrorDetails>[];
        final entries = await loadNativeLicenseEntries(
          platform: TargetPlatform.android,
          reportError: errors.add,
        ).toList();
        expect(errors.single.exception, isA<FormatException>());
        expect(
          entries.single.packages.single,
          'Native dependency notices unavailable',
        );
      },
    );
  }

  test('native load failures remain visible', () async {
    messenger.setMockMethodCallHandler(channel, (_) async {
      throw PlatformException(code: 'missing_notices');
    });
    final errors = <FlutterErrorDetails>[];
    final entries = await loadNativeLicenseEntries(
      platform: TargetPlatform.iOS,
      reportError: errors.add,
    ).toList();
    expect(errors.single.exception, isA<PlatformException>());
    expect(
      entries.single.packages.single,
      'Native dependency notices unavailable',
    );
  });
}
