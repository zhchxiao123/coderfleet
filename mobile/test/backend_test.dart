import 'package:coderfleet_mobile/src/backend.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_backend.dart';

void main() {
  test('phones use https anywhere and plain http only on private and mesh networks', () {
    expect(checkAddress('https://cf.example.com/'), 'https://cf.example.com');
    expect(checkAddress('http://192.168.1.20:8877'), 'http://192.168.1.20:8877');
    expect(checkAddress('http://100.101.5.6:8877'), 'http://100.101.5.6:8877');
    expect(checkAddress('http://mac.tail1234.ts.net:8877'), 'http://mac.tail1234.ts.net:8877');
    for (final bad in ['http://8.8.8.8:8877', 'http://cf.example.com', 'https://a.com/path', 'ftp://a.com', 'not a url']) {
      expect(() => checkAddress(bad), throwsA(isA<BackendError>()), reason: bad);
    }
    expect(privateHost('172.20.0.1'), isTrue);
    expect(privateHost('172.32.0.1'), isFalse);
  });

  test('a pairing link keeps usable addresses in order and drops public http', () {
    final profile = parsePairing('coderfleet://pair?v=1&name=%E6%9C%AC%E6%9C%BA&token=cfd_abc&url=http://192.168.1.20:8877&url=http://cf.example.com&url=https://cf.example.com', id: 'x');
    expect(profile.name, '本机');
    expect(profile.token, 'cfd_abc');
    expect(profile.addresses, ['http://192.168.1.20:8877', 'https://cf.example.com']);
    expect(() => parsePairing('https://example.com', id: 'x'), throwsA(isA<BackendError>()));
    expect(() => parsePairing('coderfleet://pair?token=main-token&url=https://a.com', id: 'x'), throwsA(isA<BackendError>()));
  });

  test('the client tries addresses in order and reconnects after a network change', () async {
    final backend = FakeBackend(reachable: {'https://cf.example.com'});
    final client = BackendClient(Profile(id: 'x', name: 'n', token: 'cfd_test', addresses: ['http://192.168.1.20:8877', 'https://cf.example.com']), client: backend.client);
    expect(await client.connect(), 'https://cf.example.com');
    expect(await client.deviceName(), 'iPhone');
    // Back home: the LAN address answers again, and wins once the current one fails.
    backend.reachable..clear()..add('http://192.168.1.20:8877');
    await expectLater(client.deviceName(), throwsA(isA<BackendError>()));
    expect(await client.deviceName(), 'iPhone');
    expect(client.address, 'http://192.168.1.20:8877');
  });

  test('a revoked device token is reported as such', () async {
    final backend = FakeBackend(token: 'cfd_other');
    final client = BackendClient(Profile(id: 'x', name: 'n', token: 'cfd_test', addresses: ['http://192.168.1.20:8877']), client: backend.client);
    await expectLater(client.connect(), throwsA(isA<BackendError>().having((error) => error.unauthorized, 'unauthorized', isTrue)));
  });
}
