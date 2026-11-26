// A saved backend (name, device token, addresses in the order to try) and the
// HTTP client that reaches it. Mirrors the backend's own rules (mobile.ts):
// https anywhere, plain http only to private and mesh addresses.
import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

class BackendError implements Exception {
  BackendError(this.message, {this.status = 0});
  final String message;
  final int status;
  bool get unauthorized => status == 401;
  @override
  String toString() => message;
}

/// Private, link-local, CGNAT (Tailscale), ULA, `.local` and `.ts.net` hosts.
bool privateHost(String host) {
  final name = host.toLowerCase().replaceAll(RegExp(r'^\[|\]$'), '');
  if (name.endsWith('.local') || name.endsWith('.ts.net') || name == 'localhost' || name == '127.0.0.1' || name == '::1') return true;
  final v4 = RegExp(r'^(\d+)\.(\d+)\.(\d+)\.(\d+)$').firstMatch(name);
  if (v4 != null) {
    final a = int.parse(v4.group(1)!), b = int.parse(v4.group(2)!);
    return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 100 && b >= 64 && b <= 127) || (a == 169 && b == 254);
  }
  return RegExp(r'^f[cd][0-9a-f]{2}:').hasMatch(name) || name.startsWith('fe80:');
}

/// A base URL a phone may use, normalized to its origin; throws a readable error otherwise.
String checkAddress(String value) {
  final url = Uri.tryParse(value.trim());
  if (url == null || !url.hasScheme || url.host.isEmpty) throw BackendError('地址格式不对，例如 https://cf.example.com');
  if (url.scheme != 'https' && url.scheme != 'http') throw BackendError('只支持 http:// 或 https://');
  if (url.userInfo.isNotEmpty || url.hasQuery || url.hasFragment || (url.path.isNotEmpty && url.path != '/')) throw BackendError('只填协议、域名和端口，不带路径');
  if (url.scheme == 'http' && !privateHost(url.host)) throw BackendError('公网地址必须用 https://（令牌不能明文经过公网）');
  return url.origin;
}

class Profile {
  Profile({required this.id, required this.name, required this.token, required this.addresses});
  factory Profile.fromJson(Map<String, dynamic> json) => Profile(
        id: json['id'] as String? ?? '', name: json['name'] as String? ?? 'CoderFleet', token: json['token'] as String? ?? '',
        addresses: (json['addresses'] as List? ?? const []).whereType<String>().toList());
  final String id, name, token;
  final List<String> addresses;
  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'token': token, 'addresses': addresses};
  Profile copyWith({String? name, List<String>? addresses}) => Profile(id: id, name: name ?? this.name, token: token, addresses: addresses ?? this.addresses);
}

/// Parses the desktop App's pairing link: coderfleet://pair?v=1&name=…&token=…&url=…&url=…
Profile parsePairing(String link, {required String id}) {
  final uri = Uri.tryParse(link.trim());
  if (uri == null || uri.scheme != 'coderfleet' || uri.host != 'pair') throw BackendError('这不是 CoderFleet 的配对码');
  final token = uri.queryParameters['token'] ?? '';
  if (!token.startsWith('cfd_')) throw BackendError('配对码里没有设备令牌，请在电脑上重新生成');
  final addresses = <String>[];
  for (final value in uri.queryParametersAll['url'] ?? const <String>[]) {
    try {
      final url = checkAddress(value);
      if (!addresses.contains(url)) addresses.add(url);
    } on BackendError {
      // An address the phone must not use (public http) is skipped.
    }
  }
  if (addresses.isEmpty) throw BackendError('配对码里没有手机能用的地址');
  return Profile(id: id, name: uri.queryParameters['name']?.trim().isNotEmpty == true ? uri.queryParameters['name']!.trim() : 'CoderFleet', token: token, addresses: addresses);
}

/// One backend: finds a reachable address (in order) and calls the chat API on it.
class BackendClient {
  BackendClient(this.profile, {http.Client? client, this.probeTimeout = const Duration(seconds: 4)}) : _http = client ?? http.Client();
  final Profile profile;
  final http.Client _http;
  final Duration probeTimeout;
  String? _base;

  /// The address in use, once one answered.
  String? get address => _base;

  /// Tries the addresses in order; the first whose /v1/health answers as a CoderFleet backend wins.
  Future<String> connect() async {
    BackendError? last;
    for (final address in profile.addresses) {
      try {
        final response = await _http.get(Uri.parse('$address/v1/health'), headers: _headers).timeout(probeTimeout);
        if (response.statusCode == 401) throw BackendError('这台手机的令牌已失效，请在电脑上重新添加手机', status: 401);
        final body = asMap(jsonDecode(utf8.decode(response.bodyBytes)));
        if (response.statusCode == 200 && body['service'] == 'coderfleet-node') return _base = address;
        last = BackendError('$address 不是 CoderFleet 后端');
      } on BackendError catch (error) {
        if (error.unauthorized) rethrow;
        last = error;
      } catch (_) {
        last = BackendError('连不上 $address');
      }
    }
    _base = null;
    throw last ?? BackendError('没有可用的地址');
  }

  Map<String, String> get _headers => {'Authorization': 'Bearer ${profile.token}', 'Content-Type': 'application/json'};

  Future<Object?> _call(String method, String path, {Object? body, Duration? timeout}) async {
    final base = _base ?? await connect();
    final request = http.Request(method, Uri.parse('$base/v1/$path'))..headers.addAll(_headers);
    if (body != null) request.body = jsonEncode(body);
    http.Response response;
    try {
      response = await http.Response.fromStream(await _http.send(request)).timeout(timeout ?? const Duration(seconds: 30));
    } on TimeoutException {
      _base = null;
      throw BackendError('后端没有响应');
    } catch (_) {
      // The network changed (Wi-Fi ↔ cellular): look for a working address next time.
      _base = null;
      throw BackendError('网络断开了，正在重连');
    }
    return _decoded(response);
  }

  /// The JSON of an answer, or the backend's error.
  Object? _decoded(http.Response response) {
    Object? data;
    try { data = jsonDecode(utf8.decode(response.bodyBytes)); } catch (_) { data = null; }
    if (response.statusCode >= 400) {
      final message = asMap(data)['error'] as String? ?? 'HTTP ${response.statusCode}';
      throw BackendError(response.statusCode == 401 ? '这台手机的令牌已失效，请在电脑上重新添加手机' : message, status: response.statusCode);
    }
    return data;
  }

  Future<String> deviceName() async => asMap(await _call('GET', 'device'))['name'] as String? ?? '';

  Future<List<Project>> projects() async => parseList(await _call('GET', 'projects'), Project.fromJson);

  Future<List<ModelOption>> models(String projectId) async =>
      parseList(await _call('GET', 'projects/${Uri.encodeComponent(projectId)}/models'), (item) => ModelOption(item['id'] as String? ?? '', item['label'] as String? ?? ''));

  /// Long poll of the conversation list: returns null when nothing changed within [wait].
  Future<({String etag, List<Conversation> conversations})?> conversationChanges(String since, {Duration wait = const Duration(seconds: 25)}) async {
    final data = asMap(await _call('GET', 'conversations/changes?since=${Uri.encodeQueryComponent(since)}&wait=${wait.inMilliseconds}', timeout: wait + const Duration(seconds: 15)));
    if (data['unchanged'] == true) return null;
    return (etag: data['etag'] as String? ?? '', conversations: parseList(data['conversations'], Conversation.fromJson));
  }

  /// Long poll of one conversation's turns.
  Future<TurnChanges> turnChanges(String conversationId, String since, {Duration wait = const Duration(seconds: 25)}) async => TurnChanges.fromJson(asMap(await _call(
      'GET', 'conversations/$conversationId/changes?since=${Uri.encodeQueryComponent(since)}&wait=${wait.inMilliseconds}', timeout: wait + const Duration(seconds: 15))));

  Future<Conversation> createConversation(String projectId) async => Conversation.fromJson(asMap(await _call('POST', 'conversations', body: {'projectId': projectId})));

  Future<void> rename(String conversationId, String name) => _call('PUT', 'conversations/$conversationId', body: {'name': name});

  Future<Delivery> send(String conversationId, {required String prompt, List<String> images = const [], String model = '', bool auto = false}) async {
    final data = asMap(await _call('POST', 'conversations/$conversationId/turns', body: {'prompt': prompt, 'images': images, 'model': model, 'auto': auto}));
    return Delivery.values.firstWhere((item) => item.name == data['delivered'], orElse: () => Delivery.turn);
  }

  Future<void> withdraw(String conversationId, String followUpId) => _call('DELETE', 'conversations/$conversationId/follow-ups/$followUpId');

  /// Uploads a file (up to 500 MB) into the project (.coderfleet-uploads); returns its container path.
  /// The file is the request body, sent as it is read.
  Future<String> upload(String projectId, String name, Stream<List<int>> data, int size) async {
    final base = _base ?? await connect();
    final request = http.StreamedRequest('POST', Uri.parse('$base/v1/projects/${Uri.encodeComponent(projectId)}/uploads').replace(queryParameters: {'name': name}))
      ..headers.addAll(_headers)
      ..headers['Content-Type'] = 'application/octet-stream'
      ..contentLength = size;
    data.listen(request.sink.add, onError: request.sink.addError, onDone: request.sink.close, cancelOnError: true);
    http.Response response;
    try {
      // At least 100 KB/s, on top of the usual allowance.
      response = await http.Response.fromStream(await _http.send(request)).timeout(Duration(seconds: 120 + size ~/ 100000));
    } on TimeoutException {
      throw BackendError('上传超时');
    } catch (_) {
      _base = null;
      throw BackendError('网络断开了，正在重连');
    }
    return asMap(_decoded(response))['path'] as String? ?? '';
  }

  Future<List<int>> image(String projectId, String path) async {
    final data = asMap(await _call('GET', 'projects/${Uri.encodeComponent(projectId)}/uploads/${path.split('/').last}', timeout: const Duration(seconds: 60)));
    return base64Decode(data['data'] as String? ?? '');
  }

  /// Branches a new conversation off a finished Claude answer.
  Future<Conversation> fork(String conversationId, String turnId) async =>
      Conversation.fromJson(asMap(await _call('POST', 'conversations/$conversationId/fork', body: {'turnId': turnId})));

  /// Whether the backend has a model for translation (SYSTEM_LLM_* on the computer).
  Future<bool> canTranslate() async => asMap(await _call('GET', 'system-llm'))['configured'] == true;

  Future<String> translate(String text, {String target = '简体中文'}) async =>
      asMap(await _call('POST', 'translate', body: {'text': text, 'target': target}, timeout: const Duration(seconds: 180)))['translated'] as String? ?? '';

  Future<ToolDetail> toolDetail(String turnId, String toolId) async => ToolDetail.fromJson(asMap(await _call('GET', 'turns/$turnId/tools/${Uri.encodeComponent(toolId)}')));

  Future<void> decide(String turnId, String permissionId, {required bool allow}) =>
      _call('POST', 'turns/$turnId/permission', body: {'id': permissionId, 'decision': allow ? 'allow' : 'deny'});

  Future<void> answer(String turnId, String permissionId, Map<String, String> answers) =>
      _call('POST', 'turns/$turnId/permission', body: {'id': permissionId, 'answers': answers});

  Future<void> cancel(String turnId) => _call('POST', 'turns/$turnId/cancel');

  void close() => _http.close();
}
