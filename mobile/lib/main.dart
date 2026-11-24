// flutter_markdown_plus builds on this library; one Material keeps one theme.
// ignore: deprecated_member_use
import 'package:flutter/material.dart';

import 'src/state.dart';
import 'src/ui/connect_screen.dart';
import 'src/ui/conversations_screen.dart';
import 'src/ui/theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final state = AppState(store: SecureProfileStore());
  state.load();
  runApp(CoderFleetApp(state: state));
}

class CoderFleetApp extends StatelessWidget {
  const CoderFleetApp({super.key, required this.state, this.feedWait = const Duration(seconds: 25), this.themeMode = ThemeMode.system, this.fontFamily, this.fontFamilyFallback});
  final AppState state;
  final Duration feedWait;
  final ThemeMode themeMode;
  final String? fontFamily;
  final List<String>? fontFamilyFallback;

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'CoderFleet',
        debugShowCheckedModeBanner: false,
        themeMode: themeMode,
        theme: buildTheme(Brightness.light, fontFamily: fontFamily, fontFamilyFallback: fontFamilyFallback),
        darkTheme: buildTheme(Brightness.dark, fontFamily: fontFamily, fontFamilyFallback: fontFamilyFallback),
        home: ListenableBuilder(
          listenable: state,
          builder: (context, _) {
            if (!state.loaded) return const Scaffold(body: Center(child: CircularProgressIndicator.adaptive()));
            if (state.current == null) return ConnectScreen(state: state);
            return ConversationsScreen(key: ValueKey(state.current!.id), state: state, feedWait: feedWait);
          },
        ),
      );
}
