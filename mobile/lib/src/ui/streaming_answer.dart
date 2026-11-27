// An answer while it is being written. Text arrives from the backend in bursts;
// here it is let out at an even pace, and only the block being written is laid
// out again. The desktop App does the same in ui/js/stream.js.
// flutter_markdown_plus builds on this library; one Material keeps one theme.
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import 'turn_view.dart';

/// What has arrived is on screen within about this long: the further behind, the faster.
const _lag = 0.45;
/// Characters a second when little is waiting.
const _minRate = 35.0;
const _fade = Duration(milliseconds: 240);

final _fenceLine = RegExp(r'^\s*(```|~~~)');
final _listItem = RegExp(r'^\s*([-*+]|\d+[.)])\s+');
final _word = RegExp(r'\w');

/// Top-level blocks of a text (split at blank lines outside code fences), so finished ones are never rebuilt.
/// A list whose items are a blank line apart stays one block: split, each item would start its own list.
List<String> answerChunks(String text) {
  final result = <String>[];
  var current = <String>[];
  String? fence;
  var gap = false;
  for (final line in text.split('\n')) {
    final mark = _fenceLine.firstMatch(line)?.group(1);
    if (mark != null) {
      if (fence == null) { fence = mark; } else if (line.trim().startsWith(fence)) { fence = null; }
    }
    if (fence == null && mark == null && line.trim().isEmpty) { gap = current.isNotEmpty; continue; }
    if (gap) {
      final inList = _listItem.hasMatch(current.first) && (_listItem.hasMatch(line) || line.startsWith('  '));
      if (inList) { current.add(''); } else { result.add(current.join('\n')); current = []; }
      gap = false;
    }
    current.add(line);
  }
  if (current.isNotEmpty) result.add(current.join('\n'));
  return result;
}

/// The block being written, with its half-written end shown as it will look once
/// finished: a marker waits for its text, a table and a code block for their first row,
/// open emphasis and code are closed, a link shows its text.
String tidyTail(String source) {
  final lines = source.split('\n');
  String rest(int count) => lines.sublist(0, lines.length - count).join('\n');
  var fence = false, opened = 0;
  for (var index = 0; index < lines.length - 1; index += 1) {
    if (_fenceLine.hasMatch(lines[index])) { fence = !fence; opened = index; }
  }
  var last = lines.last;
  if (fence) {
    // A code block shows once it has a first line of code, not as an empty box.
    if (lines.sublist(opened + 1).join().trim().isEmpty) return rest(lines.length - opened);
    return RegExp(r'^\s*(`{1,3}|~{1,3})$').hasMatch(last) ? rest(1) : source;
  }
  // A code block that is only just opening waits as well.
  if (_fenceLine.hasMatch(last)) return rest(1);
  if (RegExp(r'^\s*(#{1,6}|[-*+]|\d+[.)]?|>|`{1,3}|~{1,3})\s*$').hasMatch(last)) return rest(1);
  final row = RegExp(r'^\s*\|').hasMatch(last);
  last = last
      .replaceFirst(RegExp(r'<!(--(?:(?!-->).)*|-)?$'), '')
      .replaceFirstMapped(RegExp(r'\[([^\]]*)\]\([^)]*$'), (match) => match[1]!)
      .replaceFirstMapped(RegExp(r'\[([^\]]*)$'), (match) => match[1]!);
  if ('`'.allMatches(last).length.isOdd) {
    last = last.endsWith('`') ? last.substring(0, last.length - 1) : '$last`';
  } else {
    last = last.replaceFirst(RegExp(r'\*{1,2}$'), '');
    if ('**'.allMatches(last).length.isOdd) last += '**';
  }
  if (row) {
    var first = lines.length - 1;
    while (first > 0 && RegExp(r'^\s*\|').hasMatch(lines[first - 1])) { first -= 1; }
    final run = lines.sublist(first);
    final formed = run.length >= 3 && RegExp(r'^\s*\|.*\|\s*$').hasMatch(run[0]) && RegExp(r'^\s*\|?[\s:-]+\|[\s|:-]*$').hasMatch(run[1]);
    if (!formed) return rest(run.length);
    if (RegExp(r'^\s*\|\s*$').hasMatch(last)) return rest(1);
    if (!RegExp(r'\|\s*$').hasMatch(last)) last += ' |';
  }
  lines[lines.length - 1] = last;
  return lines.join('\n');
}

/// One text block of an answer. While [live] (more text may come) and until all of it
/// is on screen, the text is written out; after that it is the plain [Answer].
class StreamingAnswer extends StatefulWidget {
  const StreamingAnswer({super.key, required this.text, required this.live});
  final String text;
  final bool live;
  @override
  State<StreamingAnswer> createState() => _StreamingAnswerState();
}

class _StreamingAnswerState extends State<StreamingAnswer> with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_tick);
  /// Characters on screen; a text that was already finished when first seen is simply there.
  late double _shown = widget.live ? 0 : widget.text.length.toDouble();
  late bool _writing = widget.live;
  Duration? _last;
  /// The blocks as last built, by their source: an unchanged one is the same widget, so it is not built again.
  final List<({String source, Widget widget})> _built = [];

  @override
  void initState() {
    super.initState();
    _run();
  }

  @override
  void didUpdateWidget(StreamingAnswer old) {
    super.didUpdateWidget(old);
    // Text that does not continue what was there (it was replaced, or translated) is shown as it is.
    if (!widget.text.startsWith(old.text)) _shown = widget.text.length.toDouble();
    if (widget.live) _writing = true;
    _run();
  }

  void _run() {
    if (!_writing || _ticker.isActive) return;
    if (_shown >= widget.text.length) { if (!widget.live) _writing = false; return; }
    _last = null;
    _ticker.start();
  }

  void _tick(Duration elapsed) {
    final total = widget.text.length;
    final seconds = _last == null ? 0.0 : (elapsed - _last!).inMicroseconds.clamp(0, 100000) / 1e6;
    _last = elapsed;
    setState(() {
      if (MediaQuery.disableAnimationsOf(context)) _shown = total.toDouble();
      // After a pause (the App in the background, a long stall) most of what piled up is simply there.
      if (total - _shown > 1500) _shown = total - 600;
      final rate = ((total - _shown) / (widget.live ? _lag : _lag / 2)).clamp(_minRate, double.infinity);
      _shown = (_shown + rate * seconds).clamp(0, total).toDouble();
      if (_shown >= total) {
        _ticker.stop();
        if (!widget.live) _writing = false;
      }
    });
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final text = widget.text;
    if (!_writing) return Answer(text: text);
    var upTo = _shown.floor();
    // A Latin word appears whole, not letter by letter; a character of two code units is never cut.
    while (upTo > 0 && upTo < text.length &&
        ((_word.hasMatch(text[upTo]) && _word.hasMatch(text[upTo - 1])) || (text.codeUnitAt(upTo) & 0xFC00) == 0xDC00)) {
      upTo += 1;
    }
    final sources = answerChunks(text.substring(0, upTo));
    if (sources.isNotEmpty && (widget.live || upTo < text.length)) {
      final end = tidyTail(sources.last);
      if (end.trim().isEmpty) { sources.removeLast(); } else { sources[sources.length - 1] = end; }
    }
    if (_built.length > sources.length) _built.removeRange(sources.length, _built.length);
    for (var index = 0; index < sources.length; index += 1) {
      final entry = (source: sources[index], widget: _Appear(key: ValueKey(index), child: Answer(text: sources[index])) as Widget);
      if (index == _built.length) { _built.add(entry); } else if (_built[index].source != sources[index]) { _built[index] = entry; }
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [for (final entry in _built) entry.widget]);
  }
}

/// A block fades in when it first appears; as it grows it stays as it is.
class _Appear extends StatefulWidget {
  const _Appear({super.key, required this.child});
  final Widget child;
  @override
  State<_Appear> createState() => _AppearState();
}

class _AppearState extends State<_Appear> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(vsync: this, duration: _fade);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) { _controller.value = 1; } else if (!_controller.isAnimating && _controller.value == 0) { _controller.forward(); }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(opacity: CurvedAnimation(parent: _controller, curve: Curves.easeOut), child: widget.child);
}
