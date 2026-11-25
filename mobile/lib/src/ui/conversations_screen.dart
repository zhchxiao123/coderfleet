// Home: the backend's conversations, newest first, with status dots; search;
// a new conversation starts from a project picker.
import 'dart:async';

// flutter_markdown_plus builds on this library; one Material keeps one theme.
// ignore: deprecated_member_use
import 'package:flutter/material.dart';

import '../backend.dart';
import '../models.dart';
import '../notifications.dart';
import '../state.dart';
import 'chat_screen.dart';
import 'connect_screen.dart';
import 'theme.dart';

class ConversationsScreen extends StatefulWidget {
  const ConversationsScreen({super.key, required this.state, this.feedWait = const Duration(seconds: 25), this.notifier});
  final AppState state;
  final Duration feedWait;
  final Notifier? notifier;
  @override
  State<ConversationsScreen> createState() => _ConversationsScreenState();
}

class _ConversationsScreenState extends State<ConversationsScreen> with WidgetsBindingObserver {
  ConversationFeed? feed;
  String query = '';
  bool searching = false;
  bool _chatOpen = false;
  late final BackgroundWatch? _watch = widget.notifier == null ? null : BackgroundWatch(widget.notifier!);
  StreamSubscription<String>? _taps;
  String? _pendingOpen;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _attach();
    _taps = widget.notifier?.taps.listen(_openTapped);
    unawaited(widget.notifier?.init().catchError((_) {}));
  }

  @override
  void didUpdateWidget(covariant ConversationsScreen old) {
    super.didUpdateWidget(old);
    if (feed?.client != widget.state.client) _attach();
  }

  void _attach() {
    _watch?.stop();
    feed?.removeListener(_openPending);
    feed?.dispose();
    final client = widget.state.client;
    feed = client == null ? null : (ConversationFeed(client, wait: widget.feedWait)..addListener(_openPending)..start());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _watch?.stop();
      _chatOpen ? feed?.stop() : feed?.start();
    } else if (state == AppLifecycleState.paused) {
      // In the background the list keeps polling (as long as the OS lets the app run) to notify.
      if (_watch == null) {
        feed?.stop();
      } else if (feed != null) {
        _watch.start(feed!, current: !_chatOpen);
        if (_chatOpen) feed!.resync();
        feed!.start();
      }
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _taps?.cancel();
    _watch?.stop();
    feed?.dispose();
    super.dispose();
  }

  /// A tapped notification: back to the list, then into its conversation once the list has it.
  void _openTapped(String conversationId) {
    if (!mounted) return;
    Navigator.of(context).popUntil((route) => route.isFirst);
    _pendingOpen = conversationId;
    _openPending();
  }

  void _openPending() {
    final id = _pendingOpen, current = feed;
    if (id == null || current == null || !current.loaded || !mounted) return;
    _pendingOpen = null;
    final conversation = current.conversations.where((item) => item.id == id).firstOrNull;
    if (conversation == null) {
      showMessage(context, '这个对话已不存在，或不在当前后端上');
      return;
    }
    _open(conversation: conversation);
  }

  void _open({Conversation? conversation, Project? project}) {
    final client = widget.state.client, current = feed;
    if (client == null || current == null) return;
    feed?.stop();
    _chatOpen = true;
    Navigator.of(context)
        .push(MaterialPageRoute(builder: (_) => ChatScreen(client: client, feed: current, conversation: conversation, projectId: project?.id ?? conversation!.projectId)))
        .then((_) {
          _chatOpen = false;
          if (mounted) feed?.start();
        });
  }

  Future<void> _newChat() async {
    final current = feed;
    if (current == null) return;
    if (current.projects.isEmpty) await current.refreshProjects().catchError((_) {});
    if (!mounted) return;
    final projects = current.projects.where((item) => item.canChat).toList()
      ..sort((a, b) => a.running != b.running ? (a.running ? -1 : 1) : a.name.compareTo(b.name));
    final picked = await showModalBottomSheet<Project>(context: context, isScrollControlled: true, builder: (context) => ProjectPicker(projects: projects));
    if (picked != null) _open(project: picked);
  }

  void _backends() {
    final state = widget.state;
    showModalBottomSheet<void>(context: context, builder: (sheet) {
      final palette = sheet.palette;
      return SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        for (final profile in state.profiles)
          ListTile(
            leading: Icon(profile.id == state.current?.id ? Icons.check_circle : Icons.circle_outlined, color: profile.id == state.current?.id ? palette.green : palette.text3),
            title: Text(profile.name),
            subtitle: Text(profile.addresses.join(' · '), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: palette.text3, fontSize: 12)),
            onTap: () { Navigator.pop(sheet); state.switchTo(profile); },
            trailing: IconButton(icon: const Icon(Icons.more_horiz), onPressed: () { Navigator.pop(sheet); _editBackend(profile); }),
          ),
        ListTile(leading: const Icon(Icons.add), title: const Text('添加后端'), onTap: () {
          Navigator.pop(sheet);
          Navigator.of(context).push(MaterialPageRoute(builder: (_) => ConnectScreen(state: state, canClose: true)));
        }),
      ]));
    });
  }

  Future<void> _editBackend(Profile profile) async {
    final addresses = [...profile.addresses];
    final input = TextEditingController();
    final saved = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, builder: (sheet) => StatefulBuilder(builder: (sheet, setSheet) {
      final palette = sheet.palette;
      String? error;
      return Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(sheet).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(profile.name, style: Theme.of(sheet).textTheme.titleMedium),
          const SizedBox(height: 4),
          Text('按顺序尝试，用第一个连得上的。', style: TextStyle(color: palette.text3, fontSize: 12.5)),
          const SizedBox(height: 8),
          ReorderableListView(shrinkWrap: true, buildDefaultDragHandles: true, onReorderItem: (from, to) => setSheet(() {
            addresses.insert(to, addresses.removeAt(from));
          }), children: [
            for (final address in addresses)
              ListTile(key: ValueKey(address), dense: true, contentPadding: EdgeInsets.zero, title: Text(address, style: mono),
                  trailing: IconButton(icon: const Icon(Icons.close, size: 18), onPressed: addresses.length > 1 ? () => setSheet(() => addresses.remove(address)) : null)),
          ]),
          Row(children: [
            Expanded(child: TextField(controller: input, keyboardType: TextInputType.url, autocorrect: false, decoration: InputDecoration(hintText: '添加地址', errorText: error))),
            const SizedBox(width: 8),
            OutlinedButton(onPressed: () => setSheet(() {
              try {
                final url = checkAddress(input.text);
                if (!addresses.contains(url)) addresses.add(url);
                input.clear();
              } on BackendError catch (failure) {
                showMessage(context, failure.message);
              }
            }), child: const Text('添加')),
          ]),
          const SizedBox(height: 16),
          FilledButton(onPressed: () => Navigator.pop(sheet, true), child: const Text('保存')),
          TextButton(onPressed: () async {
            Navigator.pop(sheet, false);
            await widget.state.remove(profile);
          }, child: Text('从手机上移除', style: TextStyle(color: palette.red))),
        ]),
      );
    }));
    if (saved == true) await widget.state.update(profile.copyWith(addresses: addresses));
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final current = feed;
    return Scaffold(
      appBar: AppBar(
        title: searching
            ? TextField(autofocus: true, decoration: const InputDecoration(hintText: '搜索对话', border: InputBorder.none, filled: false), onChanged: (value) => setState(() => query = value.trim().toLowerCase()))
            : GestureDetector(onTap: _backends, child: Row(mainAxisSize: MainAxisSize.min, children: [
                Text(widget.state.current?.name ?? 'CoderFleet'),
                const SizedBox(width: 4),
                Icon(Icons.expand_more, size: 20, color: palette.text3),
              ])),
        actions: [
          IconButton(icon: Icon(searching ? Icons.close : Icons.search), onPressed: () => setState(() { searching = !searching; query = ''; })),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
          onPressed: _newChat, backgroundColor: palette.ink, foregroundColor: palette.inkText, icon: const Icon(Icons.edit_outlined), label: const Text('新对话')),
      body: current == null
          ? const SizedBox()
          : ListenableBuilder(listenable: current, builder: (context, _) {
              if (current.unauthorized) {
                return _Notice(icon: Icons.lock_outline, title: '这台手机已被移除', text: current.error ?? '', action: ('重新连接', () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ConnectScreen(state: widget.state, canClose: true)))));
              }
              if (!current.loaded) {
                return current.error != null
                    ? _Notice(icon: Icons.wifi_off, title: '连不上后端', text: '${current.error}\n会自动重试。也可以检查手机的网络，或在后端设置里调整地址。', action: ('后端设置', _backends))
                    : const Center(child: CircularProgressIndicator.adaptive());
              }
              final list = current.conversations.where((item) => query.isEmpty || item.name.toLowerCase().contains(query) || (current.project(item.projectId)?.name.toLowerCase().contains(query) ?? false)).toList();
              return Column(children: [
                if (current.error != null)
                  Container(width: double.infinity, color: palette.amber.withValues(alpha: 0.12), padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                      child: Text('连接中断，正在重连…', style: TextStyle(color: palette.amber, fontSize: 13))),
                Expanded(child: list.isEmpty
                    ? _Notice(icon: Icons.chat_bubble_outline, title: query.isEmpty ? '还没有对话' : '没有匹配的对话', text: query.isEmpty ? '点右下角「新对话」，选一个项目开始。' : '')
                    : ListView.separated(
                        padding: const EdgeInsets.only(bottom: 96),
                        itemCount: list.length,
                        separatorBuilder: (_, _) => Padding(padding: const EdgeInsets.only(left: 16), child: Divider(color: palette.line)),
                        itemBuilder: (context, index) {
                          final item = list[index];
                          return ListTile(
                            onTap: () => _open(conversation: item),
                            title: Text(item.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w500, color: palette.text)),
                            subtitle: Text('${current.project(item.projectId)?.name ?? item.projectId} · ${relativeTime(item.updatedAt)}',
                                maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: palette.text3, fontSize: 12.5)),
                            trailing: StatusDot(conversation: item),
                          );
                        })),
              ]);
            }),
    );
  }
}

class StatusDot extends StatelessWidget {
  const StatusDot({super.key, required this.conversation});
  final Conversation conversation;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final (color, label) = conversation.attention
        ? (palette.amber, '等你确认')
        : conversation.busy
            ? (palette.accent, '进行中')
            : conversation.status == 'failed'
                ? (palette.red, '失败')
                : (null, '');
    if (color == null) return const SizedBox(width: 8);
    return Tooltip(message: label, child: Container(width: 9, height: 9, decoration: BoxDecoration(color: color, shape: BoxShape.circle)));
  }
}

class ProjectPicker extends StatefulWidget {
  const ProjectPicker({super.key, required this.projects});
  final List<Project> projects;
  @override
  State<ProjectPicker> createState() => _ProjectPickerState();
}

class _ProjectPickerState extends State<ProjectPicker> {
  String query = '';
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final list = widget.projects.where((item) => query.isEmpty || item.name.toLowerCase().contains(query)).toList();
    return SafeArea(child: ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.7),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 8), child: Text('在哪个项目里对话？', style: Theme.of(context).textTheme.titleMedium)),
        if (widget.projects.length > 6)
          Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: TextField(
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: '搜索项目'), onChanged: (value) => setState(() => query = value.trim().toLowerCase()))),
        Flexible(child: list.isEmpty
            ? Padding(padding: const EdgeInsets.all(24), child: Text('没有能对话的项目。在电脑上新建项目后再试。', style: TextStyle(color: palette.text3)))
            : ListView(shrinkWrap: true, children: [
                for (final project in list)
                  ListTile(
                    leading: Container(width: 8, height: 8, decoration: BoxDecoration(shape: BoxShape.circle, color: project.running ? palette.green : palette.line)),
                    title: Text(project.name, style: TextStyle(color: project.running ? palette.text : palette.text2)),
                    trailing: Text(project.running ? project.typeLabel : '${project.typeLabel} · 容器未运行', style: TextStyle(color: palette.text3, fontSize: 12.5)),
                    onTap: () => Navigator.pop(context, project),
                  ),
              ])),
      ]),
    ));
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.icon, required this.title, required this.text, this.action});
  final IconData icon;
  final String title, text;
  final (String, VoidCallback)? action;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Center(child: Padding(padding: const EdgeInsets.all(32), child: Column(mainAxisSize: MainAxisSize.min, children: [
      Icon(icon, size: 36, color: palette.text3),
      const SizedBox(height: 12),
      Text(title, style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: palette.text)),
      if (text.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text(text, textAlign: TextAlign.center, style: TextStyle(color: palette.text2, height: 1.5))),
      if (action != null) Padding(padding: const EdgeInsets.only(top: 16), child: OutlinedButton(onPressed: action!.$2, child: Text(action!.$1))),
    ])));
  }
}
