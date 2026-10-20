import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Flutter notices retain full bundled asset licenses and attribution', () {
    final notices = File('NOTICES').readAsStringSync();
    final sources = {
      'Buzz': '../LICENSE',
      'Inter (modified character maps; see assets/fonts/README.md)':
          'assets/fonts/Inter-LICENSE.txt',
      'Tabler Icons': 'assets/fonts/TablerIcons-LICENSE.txt',
      'Geist Mono': 'assets/fonts/GeistMono-LICENSE.txt',
      '@emoji-mart/data 1.2.1': 'assets/emoji/LICENSE',
    };
    final expected = sources.entries
        .map(
          (entry) =>
              '${entry.key}\n\n${File(entry.value).readAsStringSync().trim()}',
        )
        .join('\n${'-' * 80}\n');
    expect(
      notices.replaceAll('\r\n', '\n').trim(),
      expected.replaceAll('\r\n', '\n'),
      reason:
          'Regenerate mobile/NOTICES with '
          'python scripts/generate-distribution-notices.py --mobile-only',
    );
  });
}
