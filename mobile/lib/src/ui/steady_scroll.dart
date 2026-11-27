// Keeps what is being read where it is while the newest turn below it grows.
// The conversation list is anchored at its end, so text arriving there would
// push everything above it up the screen. At the end itself nothing is held:
// there the view follows the new text.
import 'dart:math' as math;

import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

/// How much the newest turn's height changed in the layout under way.
class Growth {
  double pending = 0;
}

/// Reports the height changes of [child] to [growth] (none when it is null).
class TrackGrowth extends SingleChildRenderObjectWidget {
  const TrackGrowth({super.key, required this.growth, required super.child});
  final Growth? growth;
  @override
  RenderObject createRenderObject(BuildContext context) => _RenderTrackGrowth(growth);
  @override
  void updateRenderObject(BuildContext context, covariant RenderObject renderObject) => (renderObject as _RenderTrackGrowth).growth = growth;
}

class _RenderTrackGrowth extends RenderProxyBox {
  _RenderTrackGrowth(this.growth);
  Growth? growth;
  double? _height;

  @override
  void performLayout() {
    super.performLayout();
    final height = size.height, before = _height;
    _height = height;
    final target = growth;
    if (target == null || before == null || before == height) return;
    target.pending += height - before;
    // What the scroll position did not take in this frame is not carried into a later one.
    SchedulerBinding.instance.addPostFrameCallback((_) => target.pending = 0);
  }
}

/// Away from the end, the position moves by what the newest turn grew: the text on screen stays put.
class SteadyPhysics extends ScrollPhysics {
  const SteadyPhysics(this.growth, {super.parent});
  final Growth growth;

  @override
  SteadyPhysics applyTo(ScrollPhysics? ancestor) => SteadyPhysics(growth, parent: buildParent(ancestor));

  @override
  double adjustPositionForNewDimensions({required ScrollMetrics oldPosition, required ScrollMetrics newPosition, required bool isScrolling, required double velocity}) {
    final base = super.adjustPositionForNewDimensions(oldPosition: oldPosition, newPosition: newPosition, isScrolling: isScrolling, velocity: velocity);
    final grew = growth.pending;
    growth.pending = 0;
    if (grew == 0 || oldPosition.pixels <= 1) return base;
    return math.max(0, math.min(base + grew, math.max(base, newPosition.maxScrollExtent))).toDouble();
  }
}
