// An in-memory CoderFleet backend speaking the chat API (node-app/src/server.ts),
// for widget tests and screenshots. Turns finish after a few change-feed polls.
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// A 1×1 PNG, for a tool that returned an image.
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

class FakeBackend {
  FakeBackend({this.token = 'cfd_test', this.reachable = const {'http://192.168.1.20:8877'}});
  final String token;
  final Set<String> reachable;
  final List<Map<String, dynamic>> requests = [];
  /// Every request's URL, to see what was asked for (page sizes, searches).
  final List<Uri> queries = [];
  int _version = 0, _ids = 0;

  final projects = <Map<String, dynamic>>[
    {'id': 'coderfleet', 'name': 'coderfleet', 'type': 'claude', 'typeLabel': 'Claude Code', 'state': 'running', 'chat': true, 'active': true},
    {'id': 'reminis-app', 'name': 'reminis-app', 'type': 'codex', 'typeLabel': 'Codex CLI', 'state': 'running', 'chat': true, 'active': true},
    {'id': 'agy-lab', 'name': 'agy-lab', 'type': 'antigravity', 'typeLabel': 'Antigravity CLI', 'state': 'missing', 'chat': true, 'active': true},
  ];
  final conversations = <Map<String, dynamic>>[];
  final turns = <String, List<Map<String, dynamic>>>{};
  final followUps = <String, List<Map<String, dynamic>>>{};
  final uploads = <String, String>{};
  /// Whether a translation model is configured (GET system-llm).
  bool translation = true;
  /// Turn ID → remaining polls before it finishes.
  final pending = <String, int>{};
  /// 领航 (GET lead/changes): null is a backend from before it (404).
  Map<String, dynamic>? lead;
  final leadItems = <Map<String, dynamic>>[];

  String _id() => (++_ids).toRadixString(16).padLeft(12, '0');
  void _touch() => _version++;
  /// After a test changed a turn in place: the feeds see it.
  void changed() => _touch();

  Map<String, dynamic> conversation(String projectId, String name, {String status = 'done', bool attention = false, DateTime? updatedAt}) {
    final item = <String, dynamic>{'id': _id(), 'projectId': projectId, 'name': name, 'status': status, 'attention': attention,
      'updatedAt': (updatedAt ?? DateTime.now()).toUtc().toIso8601String(), 'turns': 0};
    conversations.insert(0, item);
    turns[item['id'] as String] = [];
    _touch();
    return item;
  }

  Map<String, dynamic> addTurn(String conversationId, Map<String, dynamic> turn) {
    final full = {'id': _id(), 'prompt': '', 'images': <String>[], 'status': 'done', 'answer': '', 'tools': <Map<String, dynamic>>[], 'blocks': <Map<String, dynamic>>[],
      'controlReady': false, 'capabilities': <String>[], ...turn};
    turns[conversationId]!.add(full);
    final summary = conversations.firstWhere((item) => item['id'] == conversationId);
    summary['turns'] = turns[conversationId]!.length;
    summary['status'] = full['status'];
    summary['attention'] = full['permission'] != null;
    // Like the backend: the line a finished answer ended on.
    final last = (full['blocks'] as List).cast<Map<String, dynamic>>().where((block) => block['kind'] == 'text').lastOrNull;
    summary['preview'] = full['status'] == 'done' ? '${last?['text'] ?? full['answer']}'.replaceAll(RegExp(r'[#*`\s]+'), ' ').trim() : '';
    _touch();
    return full;
  }

  void _advance() {
    for (final entry in pending.entries.toList()) {
      final turn = turns.values.expand((list) => list).firstWhere((item) => item['id'] == entry.key);
      if (turn['permission'] != null) continue;
      if (entry.value > 0) {
        pending[entry.key] = entry.value - 1;
        continue;
      }
      pending.remove(entry.key);
      final answer = 'echo:${turn['prompt']}';
      turn..['status'] = 'done'..['answer'] = answer..['blocks'] = [{'kind': 'text', 'text': answer}]..['controlReady'] = false;
      final conversation = conversations.firstWhere((item) => turns[item['id']]!.contains(turn));
      conversation['status'] = 'done';
      final queued = followUps[conversation['id']] ?? [];
      if (queued.isNotEmpty) {
        final next = queued.removeAt(0);
        _start(conversation['id'] as String, next['text'] as String, (next['images'] as List).cast<String>());
      }
      _touch();
    }
  }

  Map<String, dynamic> _start(String conversationId, String prompt, List<String> images, [String model = '']) {
    final turn = addTurn(conversationId, {'prompt': prompt, 'images': images, 'requestedModel': model, 'status': 'running', 'controlReady': true,
      'capabilities': projects.first['id'] == conversations.firstWhere((item) => item['id'] == conversationId)['projectId'] ? ['approval', 'interrupt', 'message'] : ['interrupt']});
    pending[turn['id'] as String] = 12;
    return turn;
  }

  /// Like the real long poll, an unchanged answer takes a moment (shortened for tests).
  Future<http.Response> _unchanged(http.Request request, String etag) async {
    final wait = int.tryParse(request.url.queryParameters['wait'] ?? '') ?? 0;
    if (wait > 0) await Future<void>.delayed(const Duration(milliseconds: 300));
    return _json({'etag': etag, 'unchanged': true});
  }

  http.Response _json(Object? value, [int status = 200]) => http.Response.bytes(utf8.encode(jsonEncode(value)), status, headers: {'content-type': 'application/json'});

  late final http.Client client = MockClient((request) async {
    final base = request.url.origin;
    if (!reachable.contains(base)) throw http.ClientException('connection refused', request.url);
    if (request.headers['Authorization'] != 'Bearer $token') return _json({'error': 'Invalid backend token'}, 401);
    final path = request.url.path.replaceFirst('/v1/', '');
    // An upload is the file itself, named in the query.
    final raw = request.headers['Content-Type'] == 'application/octet-stream';
    final body = raw || request.body.isEmpty ? <String, dynamic>{} : (jsonDecode(request.body) as Map).cast<String, dynamic>();
    queries.add(request.url);
    requests.add({'method': request.method, 'path': path, 'body': body, if (raw) 'name': request.url.queryParameters['name'], if (raw) 'bytes': request.bodyBytes});
    final parts = path.split('/');
    switch ((request.method, parts)) {
      case ('GET', ['health']):
        return _json({'service': 'coderfleet-node', 'version': 1});
      case ('GET', ['device']):
        return _json({'id': 'd1', 'name': 'iPhone'});
      case ('GET', ['projects']):
        return _json(projects);
      case ('GET', ['projects', final id, 'models']):
        return _json(id == 'coderfleet' ? [{'id': 'opus', 'label': 'Opus'}, {'id': 'sonnet', 'label': 'Sonnet'}] : []);
      case ('GET', ['conversations', 'changes']):
        _advance();
        final limit = int.tryParse(request.url.queryParameters['limit'] ?? '') ?? conversations.length, q = request.url.queryParameters['q'] ?? '';
        final found = conversations.where((item) => '${item['name']} ${item['projectId']}'.toLowerCase().contains(q)).toList();
        final etag = 'v$_version-$limit-$q';
        if (request.url.queryParameters['since'] == etag) return _unchanged(request, etag);
        // Like the backend: the ones waiting for the user first.
        final ordered = [...found.where((item) => item['attention'] == true), ...found.where((item) => item['attention'] != true)];
        return _json({'etag': etag, 'conversations': ordered.take(limit).toList(), 'total': found.length});
      case ('POST', ['conversations']):
        return _json(conversation(body['projectId'] as String, '新对话', status: '')..addAll({'account': ?body['account']}), 201);
      case ('PUT', ['conversations', final id]):
        conversations.firstWhere((item) => item['id'] == id)['name'] = body['name'];
        _touch();
        return _json({'id': id});
      case ('GET', ['conversations', final id, 'changes']):
        _advance();
        final etag = 'v$_version';
        if (request.url.queryParameters['since'] == etag) return _unchanged(request, etag);
        final all = turns[id] ?? [], last = int.tryParse(request.url.queryParameters['last'] ?? '') ?? all.length;
        final list = all.sublist(all.length > last ? all.length - last : 0);
        return _json({'etag': etag, 'full': true, 'order': [for (final turn in list) turn['id']], 'turns': list, 'followUps': followUps[id] ?? [], 'earlier': all.length - list.length});
      case ('GET', ['conversations', final id, 'turns']):
        final all = turns[id] ?? [], end = all.indexWhere((turn) => turn['id'] == request.url.queryParameters['before']);
        if (end < 0) return _json({'error': 'Turn not found'}, 404);
        final start = end - (int.tryParse(request.url.queryParameters['limit'] ?? '') ?? end);
        return _json({'turns': all.sublist(start < 0 ? 0 : start, end), 'earlier': start < 0 ? 0 : start});
      case ('POST', ['conversations', final id, 'turns']):
        final prompt = body['prompt'] as String, images = (body['images'] as List).cast<String>();
        final running = turns[id]!.where((turn) => turn['status'] == 'running').firstOrNull;
        if (running == null) {
          final turn = _start(id, prompt, images, body['model'] as String? ?? '');
          final summary = conversations.firstWhere((item) => item['id'] == id);
          if (summary['name'] == '新对话') summary['name'] = prompt;
          return _json({'delivered': 'turn', 'turn': turn});
        }
        if ((running['capabilities'] as List).contains('message')) {
          (running['blocks'] as List).add({'kind': 'user', 'text': prompt, 'images': images});
          _touch();
          return _json({'delivered': 'message'});
        }
        final item = {'id': _id(), 'text': prompt, 'images': images};
        (followUps[id] ??= []).add(item);
        _touch();
        return _json({'delivered': 'queued', 'followUp': item});
      case ('DELETE', ['conversations', final id, 'follow-ups', final item]):
        followUps[id]?.removeWhere((entry) => entry['id'] == item);
        _touch();
        return _json({'removed': true});
      case ('POST', ['projects', _, 'uploads']):
        final path = '/workspace/.coderfleet-uploads/${_id()}a1b2-${request.url.queryParameters['name']}';
        uploads[path] = base64Encode(request.bodyBytes);
        return _json({'path': path});
      case ('GET', ['projects', _, 'uploads', final file]):
        final data = uploads.entries.where((entry) => entry.key.endsWith(file)).firstOrNull?.value;
        return data == null ? _json({'error': '图片不存在'}, 404) : _json({'mime': 'image/png', 'data': data});
      case ('GET', ['turns', final turnId, 'tools', final toolId]):
        final turn = turns.values.expand((list) => list).firstWhere((item) => item['id'] == turnId);
        final tool = (turn['tools'] as List).cast<Map<String, dynamic>>().firstWhere((item) => item['id'] == Uri.decodeComponent(toolId));
        return _json({'id': tool['id'], 'title': tool['title'], 'status': tool['status'], 'input': tool['input'] ?? {}, 'output': tool['output'] ?? '', 'images': tool['images'] ?? []});
      case ('GET', ['turns', _, 'files']):
        final path = request.url.queryParameters['path'] ?? '';
        return _json({'name': path.split('/').last, 'size': 4, 'data': base64Encode(utf8.encode('file'))});
      case ('GET', ['system-llm']):
        return _json({'configured': translation, 'provider': 'openai', 'model': 'demo'});
      case ('POST', ['translate']):
        return _json({'translated': '译：${body['text']}', 'cached': false});
      case ('POST', ['conversations', final id, 'fork']):
        final source = conversations.firstWhere((item) => item['id'] == id);
        final child = conversation(source['projectId'] as String, '${source['name']}（分叉）');
        final list = turns[id]!;
        final upTo = list.indexWhere((turn) => turn['id'] == body['turnId']);
        turns[child['id'] as String] = [for (final turn in list.take(upTo + 1)) {...turn, 'inherited': true}];
        return _json(child);
      case ('POST', ['turns', final turnId, 'permission']):
        final turn = turns.values.expand((list) => list).firstWhere((item) => item['id'] == turnId);
        final allowed = body['decision'] == 'allow' || body['answers'] != null;
        final toolId = (turn['permission'] as Map)['toolId'];
        for (final tool in (turn['tools'] as List).cast<Map<String, dynamic>>()) {
          if (tool['id'] == toolId) tool['status'] = allowed ? 'completed' : 'denied';
        }
        turn.remove('permission');
        conversations.firstWhere((item) => turns[item['id']]!.contains(turn))['attention'] = false;
        pending[turnId] = 0;
        _touch();
        return _json({'accepted': true});
      case ('GET', ['lead', 'changes']) when lead != null:
        final etag = 'l$_version';
        if (request.url.queryParameters['since'] == etag) return _unchanged(request, etag);
        final open = leadItems.where((item) => item['type'] == 'ask' && item['resolved'] == null).length;
        return _json({'etag': etag, ...lead!, 'waiting': open, 'items': leadItems});
      case ('POST', ['lead', 'messages']) when lead != null:
        final item = {'id': _id(), 'at': DateTime.now().toUtc().toIso8601String(), 'type': 'user', 'text': body['text']};
        leadItems.add(item);
        _touch();
        return _json({'item': item});
      case ('POST', ['lead', 'asks', final id]) when lead != null:
        final ask = leadItems.where((item) => item['id'] == id && item['type'] == 'ask').firstOrNull;
        if (ask == null || ask['resolved'] != null) return _json({'error': '这张卡片已经处理过了'}, 409);
        final answer = body['answer'] as String? ?? '', answers = (body['answers'] as Map?)?.cast<String, String>();
        // Like the backend: an approval takes only its two words, a question needs its picks.
        if (ask['kind'] == 'approval' && answer != '批准' && answer != '拒绝') return _json({'error': '这张卡片只能选「批准」或「拒绝」'}, 409);
        if (ask['kind'] == 'question' && (answers == null || answers.isEmpty)) return _json({'error': '先选一个答案'}, 409);
        ask['resolved'] = {'answer': answers == null ? answer : answers.values.join('；'), 'by': 'user'};
        _touch();
        return _json({'accepted': true});
      case ('POST', ['lead', 'undo', final id]) when lead != null:
        final did = leadItems.where((item) => item['id'] == id && item['type'] == 'did').firstOrNull;
        if (did == null || did['undo'] != 'stop' || did['undone'] == true) return _json({'error': '这一轮已经结束了，撤不回了'}, 409);
        did..['undone'] = true..['undo'] = '';
        _touch();
        return _json({'accepted': true});
      case ('POST', ['turns', final turnId, 'cancel']):
        final turn = turns.values.expand((list) => list).firstWhere((item) => item['id'] == turnId);
        turn['status'] = 'cancelled';
        pending.remove(turnId);
        _touch();
        return _json({'accepted': true});
    }
    return _json({'error': 'Unknown API endpoint'}, 404);
  });

  /// 领航 on, following two projects: its thread holds the user's words, its answers, what it settled and one card of each kind.
  /// Returns the conversations it names, by a short key.
  Map<String, Map<String, dynamic>> seedLead() {
    final now = DateTime.now();
    final login = conversation('reminis-app', '修登录页', status: 'running', updatedAt: now.subtract(const Duration(minutes: 2)));
    final port = conversation('coderfleet', '端口读环境变量', attention: true, updatedAt: now.subtract(const Duration(minutes: 1)));
    final docs = conversation('coderfleet', '补文档', status: 'failed', updatedAt: now.subtract(const Duration(minutes: 30)));
    final at = now.toUtc().toIso8601String();
    Map<String, dynamic> about(Map<String, dynamic> conversation) =>
        {'conversationId': conversation['id'], 'conversation': conversation['name'], 'projectId': conversation['projectId'], 'turnId': 't-${conversation['id']}', 'at': at};
    lead = {
      'configured': true, 'model': 'demo', 'enabled': true, 'rules': [{'id': 'r1', 'text': '删除、推送这类要紧的操作一律问你', 'fixed': true}, {'id': 'r2', 'text': '测试没过不收下'}],
      'manual': <String>[], 'rest': 4, 'working': 'Demo', 'draft': '', 'step': '在读对话「修登录页」',
      'watching': [
        {'id': port['id'], 'name': port['name'], 'projectId': 'coderfleet', 'account': 'claude-1', 'status': 'waiting', 'note': '等你批准', 'at': at},
        {'id': login['id'], 'name': login['name'], 'projectId': 'reminis-app', 'account': 'codex-1', 'status': 'running', 'note': '在跑', 'at': ''},
        {'id': docs['id'], 'name': docs['name'], 'projectId': 'coderfleet', 'account': 'claude-1', 'status': 'failed', 'note': '失败了', 'at': at},
      ],
    };
    leadItems.addAll([
      {'id': 'u1', 'at': at, 'type': 'user', 'text': '现在都在忙什么'},
      {'id': 'l1', 'at': at, 'type': 'lead', 'text': '[修登录页](conv:${login['id']})'},
      {'id': 'd1', 'type': 'did', 'action': 'approve', ...about(login), 'asked': 'npm test', 'said': '', 'reason': '只是跑测试', 'undo': 'stop', 'undone': false,
        'evidence': [{'command': 'git status --short', 'output': ' M src/login.ts'}]},
      {'id': 's1', 'type': 'seen', ...about(docs)},
      {'id': 'a1', 'type': 'ask', 'kind': 'approval', ...about(port), 'asked': '要执行 git push origin main', 'quote': '', 'why': '推送一律问你', 'lean': '',
        'options': ['批准', '拒绝'], 'free': false, 'evidence': <Map<String, dynamic>>[], 'resolved': null},
      {'id': 'a2', 'type': 'ask', 'kind': 'question', ...about(port), 'asked': '端口默认用多少？', 'why': '', 'lean': '', 'options': <String>[], 'free': false,
        'questions': [{'question': '默认端口', 'header': '端口', 'multiSelect': false, 'options': [{'label': '8080', 'description': ''}, {'label': '8877', 'description': ''}]}],
        'evidence': <Map<String, dynamic>>[], 'resolved': null},
      {'id': 'a3', 'type': 'ask', 'kind': 'job', ...about(login), 'asked': '「修登录页」做完了，等收下', 'why': '改了 3 个文件，测试都过了', 'lean': '', 'options': ['收下并合并', '我去看'],
        'free': false, 'evidence': <Map<String, dynamic>>[], 'resolved': null},
      {'id': 'a4', 'type': 'ask', 'kind': 'finished', ...about(docs), 'asked': '文档写到 README 还是 docs/？', 'quote': '我应该把文档写到哪里？', 'why': '', 'lean': '我倾向 docs/',
        'options': ['我去看'], 'free': true, 'evidence': <Map<String, dynamic>>[], 'resolved': null},
      {'id': 'a5', 'type': 'ask', 'kind': 'approval', ...about(port), 'asked': '要删除 dist/', 'quote': '', 'why': '删除一律问你', 'lean': '', 'options': ['批准', '拒绝'],
        'free': false, 'evidence': <Map<String, dynamic>>[], 'resolved': {'answer': '拒绝', 'by': 'user'}},
    ]);
    _touch();
    return {'login': login, 'port': port, 'docs': docs};
  }

  /// A realistic demo: a finished answer with Markdown and tools, and one waiting for approval.
  void seedDemo() {
    final now = DateTime.now();
    final fix = conversation('coderfleet', '请帮我梳理一下服务启动流程', attention: true, updatedAt: now.subtract(const Duration(minutes: 3)));
    addTurn(fix['id'] as String, {
      'prompt': '请帮我梳理一下服务启动流程', 'type': 'claude', 'sessionId': 'session-1', 'conversationId': fix['id'],
      'images': ['/workspace/.coderfleet-uploads/0123456789abcdef-启动日志.txt'],
      'createdAt': now.subtract(const Duration(minutes: 5)).toUtc().toIso8601String(), 'finishedAt': now.subtract(const Duration(minutes: 4)).toUtc().toIso8601String(),
      'tools': [
        {'id': 'r1', 'title': 'Read', 'status': 'completed', 'detail': 'docs/arch.png', 'hasDetail': true, 'input': {'file_path': '/workspace/docs/arch.png'}, 'output': '',
          'images': [{'mime': 'image/png', 'data': tinyPng}]},
        {'id': 'r2', 'title': 'Grep', 'status': 'completed', 'detail': 'listen', 'hasDetail': true, 'input': {'pattern': 'listen'}, 'output': 'src/server.ts:602: server.listen(config.port, config.host)'},
        {'id': 'a1', 'title': 'Agent', 'status': 'completed', 'detail': '查找配置读取的位置', 'hasDetail': true},
        {'id': 'a1-1', 'title': 'Glob', 'status': 'completed', 'detail': 'src/**/*.ts', 'parent': 'a1'},
        {'id': 'a1-2', 'title': 'Read', 'status': 'completed', 'detail': 'src/conf.ts', 'parent': 'a1'},
      ],
      'blocks': [
        {'kind': 'tool', 'id': 'r1'}, {'kind': 'tool', 'id': 'r2'}, {'kind': 'tool', 'id': 'a1'},
        {'kind': 'text', 'text': '## 服务启动流程\n\n入口在 `src/server.ts`，启动时依次做三件事：\n\n1. 读取 `config.json`，校验端口和令牌；\n2. 载入会话和任务记录；\n3. 监听 **127.0.0.1**，所有请求都要带令牌。\n\n```ts\nconst server = await serve(configPath);\n```'},
      ],
      'answer': '## 服务启动流程',
    });
    addTurn(fix['id'] as String, {
      'prompt': '请把端口改成读取环境变量', 'status': 'running', 'controlReady': true, 'capabilities': ['approval', 'interrupt', 'message'],
      'tools': [
        {'id': 'e1', 'title': 'Read', 'status': 'completed', 'detail': 'src/server.ts', 'hasDetail': true},
        {'id': 'e2', 'title': 'Edit', 'status': 'waiting', 'detail': 'src/server.ts', 'hasDetail': true},
      ],
      'blocks': [{'kind': 'tool', 'id': 'e1'}, {'kind': 'text', 'text': '好的，我来修改监听端口。'}, {'kind': 'tool', 'id': 'e2'}],
      'permission': {'id': 'p1', 'title': 'Edit', 'allow': true, 'toolId': 'e2',
        'details': jsonEncode({'file_path': '/workspace/src/server.ts', 'old_string': 'server.listen(8080)', 'new_string': 'server.listen(Number(process.env.PORT ?? 8080))'})},
    });
    conversations.firstWhere((item) => item['id'] == fix['id'])['status'] = 'running';
    final check = conversation('coderfleet', '请运行检查并修复', status: 'failed', updatedAt: now.subtract(const Duration(hours: 2)));
    addTurn(check['id'] as String, {
      'prompt': '请运行检查并修复', 'status': 'failed', 'error': 'Claude Code stopped with error_max_turns',
      'tools': [
        {'id': 'c1', 'title': 'Bash', 'status': 'failed', 'detail': 'npm test', 'hasDetail': true, 'input': {'command': 'npm test'}, 'output': '1 failing\n  server.test.ts: expected 200, got 401'},
        {'id': 'c2', 'title': 'Bash', 'status': 'completed', 'detail': 'export GIT_DIR=/workspace/.git/worktrees/node-electron-worktree GIT_WORK_TREE=\$PWD && git status', 'hasDetail': true},
      ],
      'blocks': [{'kind': 'tool', 'id': 'c1'}, {'kind': 'tool', 'id': 'c2'}, {'kind': 'text', 'text': '有一个测试失败，我先看看原因。'}],
    });
    conversations.firstWhere((item) => item['id'] == check['id'])['status'] = 'failed';
    final style = conversation('reminis-app', '修一下登录页的样式', updatedAt: now.subtract(const Duration(days: 1, hours: 2)));
    addTurn(style['id'] as String, {'prompt': '修一下登录页的样式', 'answer': '已调整登录页的间距和按钮颜色。', 'blocks': [{'kind': 'text', 'text': '已调整登录页的间距和按钮颜色。'}]});
    conversations.sort((a, b) => (b['updatedAt'] as String).compareTo(a['updatedAt'] as String));
  }
}
