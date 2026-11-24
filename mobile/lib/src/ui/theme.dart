// Colors follow the desktop App (node-app/ui/theme.css): cool neutral canvas,
// ink primary actions, status colors for tools.
// flutter_markdown_plus builds on this library; one Material keeps one theme.
// ignore: deprecated_member_use
import 'package:flutter/material.dart';

class Palette extends ThemeExtension<Palette> {
  const Palette({
    required this.canvas, required this.surface, required this.fill, required this.line, required this.text, required this.text2,
    required this.text3, required this.ink, required this.inkText, required this.accent, required this.green, required this.red,
    required this.amber, required this.code,
  });
  final Color canvas, surface, fill, line, text, text2, text3, ink, inkText, accent, green, red, amber, code;

  static const light = Palette(
    canvas: Color(0xFFF2F3F6), surface: Colors.white, fill: Color(0x0E263148), line: Color(0x17263148), text: Color(0xFF151A24),
    text2: Color(0xFF4A5263), text3: Color(0xFF8A91A0), ink: Color(0xFF151A24), inkText: Colors.white, accent: Color(0xFF4A63E7),
    green: Color(0xFF1F9D55), red: Color(0xFFD64545), amber: Color(0xFFC97A0A), code: Color(0xFF0F1115),
  );
  static const dark = Palette(
    canvas: Color(0xFF111318), surface: Color(0xFF1B1E25), fill: Color(0x12DCE4F5), line: Color(0x1FDCE4F5), text: Color(0xFFE8EBF2),
    text2: Color(0xFFB4BAC6), text3: Color(0xFF7D8596), ink: Color(0xFFE8EBF2), inkText: Color(0xFF111318), accent: Color(0xFF8197FF),
    green: Color(0xFF4CC38A), red: Color(0xFFF07070), amber: Color(0xFFE6A23C), code: Color(0xFF0B0D11),
  );

  @override
  Palette copyWith() => this;
  @override
  Palette lerp(Palette? other, double t) => t < 0.5 ? this : (other ?? this);
}

extension PaletteOf on BuildContext {
  Palette get palette => Theme.of(this).extension<Palette>() ?? Palette.light;
}

/// [fontFamily] and [fontFamilyFallback] are for tests; on phones the system font (with its CJK fallback) is used.
ThemeData buildTheme(Brightness brightness, {String? fontFamily, List<String>? fontFamilyFallback}) {
  final palette = brightness == Brightness.dark ? Palette.dark : Palette.light;
  final base = ThemeData(brightness: brightness, useMaterial3: true, colorSchemeSeed: palette.accent, fontFamily: fontFamily, fontFamilyFallback: fontFamilyFallback);
  return base.copyWith(
    scaffoldBackgroundColor: palette.canvas,
    extensions: [palette],
    colorScheme: base.colorScheme.copyWith(surface: palette.surface, primary: palette.ink, onPrimary: palette.inkText),
    appBarTheme: AppBarTheme(backgroundColor: palette.canvas, foregroundColor: palette.text, elevation: 0, scrolledUnderElevation: 0.5, centerTitle: false,
        titleTextStyle: base.textTheme.titleMedium?.copyWith(fontSize: 17, fontWeight: FontWeight.w600, color: palette.text)),
    dividerTheme: DividerThemeData(color: palette.line, thickness: 0.5, space: 0.5),
    filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(backgroundColor: palette.ink, foregroundColor: palette.inkText,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)), minimumSize: const Size(0, 46))),
    outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(foregroundColor: palette.text, side: BorderSide(color: palette.line),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)), minimumSize: const Size(0, 46))),
    inputDecorationTheme: InputDecorationTheme(filled: true, fillColor: palette.surface, isDense: true,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: palette.line)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: palette.line)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: palette.accent, width: 1.4))),
    bottomSheetTheme: BottomSheetThemeData(backgroundColor: palette.surface, showDragHandle: true,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20)))),
    snackBarTheme: SnackBarThemeData(behavior: SnackBarBehavior.floating, backgroundColor: palette.ink, contentTextStyle: TextStyle(color: palette.inkText)),
  );
}

const mono = TextStyle(fontFamily: 'monospace', fontFamilyFallback: ['Menlo', 'Courier'], fontSize: 12.5, height: 1.5);

OverlayEntry? _toast;

/// A short notice at the top of the screen, clear of the composer and its buttons.
void showMessage(BuildContext context, String text) {
  final overlay = Overlay.maybeOf(context, rootOverlay: true);
  if (overlay == null) return;
  final palette = context.palette;
  _toast?.remove();
  late final OverlayEntry entry;
  entry = OverlayEntry(builder: (context) => Positioned(
    top: MediaQuery.of(context).padding.top + 8, left: 16, right: 16,
    child: IgnorePointer(child: Material(
      color: Colors.transparent,
      child: Center(child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(color: palette.ink, borderRadius: BorderRadius.circular(12),
            boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.18), blurRadius: 16, offset: const Offset(0, 4))]),
        child: Text(text, style: TextStyle(color: palette.inkText, fontSize: 14)),
      )),
    )),
  ));
  _toast = entry;
  overlay.insert(entry);
  Future<void>.delayed(const Duration(seconds: 3), () {
    if (_toast == entry) _toast = null;
    if (entry.mounted) entry.remove();
  });
}

/// "刚刚", "5 分钟前", "昨天", "11月3日".
String relativeTime(DateTime time, {DateTime? now}) {
  final current = now ?? DateTime.now();
  final diff = current.difference(time);
  if (diff.inMinutes < 1) return '刚刚';
  if (diff.inHours < 1) return '${diff.inMinutes} 分钟前';
  final local = time.toLocal(), today = DateTime(current.year, current.month, current.day);
  if (!local.isBefore(today)) return '${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
  if (!local.isBefore(today.subtract(const Duration(days: 1)))) return '昨天';
  return '${local.month}月${local.day}日';
}
