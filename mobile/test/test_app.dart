// Shared setup for widget tests and screenshots: real fonts (Latin, CJK, mono, icons)
// and the app wired to a FakeBackend.
import 'dart:io';
import 'dart:ui' show ImageByteFormat;

import 'package:flutter/rendering.dart' show RenderRepaintBoundary;

import 'package:coderfleet_mobile/main.dart';
import 'package:coderfleet_mobile/src/backend.dart';
import 'package:coderfleet_mobile/src/state.dart';
import 'package:flutter/services.dart';
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_backend.dart';

bool _fontsLoaded = false;

Future<void> loadFonts() async {
  if (_fontsLoaded) return;
  _fontsLoaded = true;
  final flutter = Platform.environment['FLUTTER_ROOT'] ?? '${Platform.environment['HOME']}/flutter';
  final material = '$flutter/bin/cache/artifacts/material_fonts';
  /// Loads the first set of files that exists (Linux paths, then macOS ones).
  Future<void> load(String family, List<String> files, [List<String> macos = const []]) async {
    final loader = FontLoader(family);
    final present = files.where((path) => File(path).existsSync()).toList();
    for (final file in present.isNotEmpty ? present : macos.where((path) => File(path).existsSync())) {
      loader.addFont(Future.value(ByteData.view(File(file).readAsBytesSync().buffer)));
    }
    await loader.load();
  }
  await load('Roboto', ['$material/Roboto-Regular.ttf', '$material/Roboto-Medium.ttf', '$material/Roboto-Bold.ttf']);
  await load('NotoCJK', ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'],
      ['/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/STHeiti Light.ttc', '/System/Library/Fonts/STHeiti Medium.ttc']);
  await load('monospace', ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'], ['/System/Library/Fonts/Menlo.ttc', '/System/Library/Fonts/SFNSMono.ttf']);
  await load('MaterialIcons', ['$material/MaterialIcons-Regular.otf']);
}

const profile = (id: 'p1', address: 'http://192.168.1.20:8877');
final appKey = GlobalKey();

/// Writes the current frame as a PNG (for looking at the layout, not compared).
Future<void> screenshot(WidgetTester tester, String path) async {
  await tester.runAsync(() async {
    await Future<void>.delayed(const Duration(milliseconds: 200));
    final boundary = appKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: tester.view.devicePixelRatio);
    final bytes = await image.toByteData(format: ImageByteFormat.png);
    File(path)..parent.createSync(recursive: true)..writeAsBytesSync(bytes!.buffer.asUint8List());
  });
}

/// The app, signed in to [backend] (unless [signedIn] is false).
Future<AppState> pumpApp(WidgetTester tester, FakeBackend backend, {bool signedIn = true, ThemeMode mode = ThemeMode.light}) async {
  await loadFonts();
  final store = MemoryProfileStore(signedIn ? [Profile(id: profile.id, name: '本机', token: backend.token, addresses: [profile.address])] : []);
  final state = AppState(store: store, clientFactory: (item) => BackendClient(item, client: backend.client));
  await state.load();
  await tester.pumpWidget(RepaintBoundary(key: appKey, child: CoderFleetApp(state: state, themeMode: mode, fontFamily: 'Roboto', fontFamilyFallback: const ['NotoCJK'])));
  await settle(tester);
  return state;
}

/// Lets feeds poll a few times (spinners never settle, so no pumpAndSettle).
Future<void> settle(WidgetTester tester, [int rounds = 8]) async {
  for (var index = 0; index < rounds; index++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump(const Duration(milliseconds: 350));
  }
}

/// Removes the app so feeds stop and no timers stay pending.
Future<void> teardown(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 2));
}
