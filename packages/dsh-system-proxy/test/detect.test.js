import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScutilOutput, detectFromEnv, formatProxyUrl } from '../lib/detect.js'

// Sample 1: HTTP + HTTPS proxies enabled.
const SCUTIL_HTTP_HTTPS = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : 192.168.1.1
  HTTPSEnable : 1
  HTTPSPort : 8443
  HTTPSProxy : 192.168.1.1
  ProxyAutoConfigEnable : 0
  ProxyAutoConfigURLString : <empty>
  SOCKSEnable : 0
}
`

// Sample 2: PAC / WPAD URL only.
const SCUTIL_PAC = `<dictionary> {
  HTTPEnable : 0
  HTTPProxy : <empty>
  HTTPSEnable : 0
  HTTPSProxy : <empty>
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://wpad.example.com/proxy.pac
  SOCKSEnable : 0
}
`

test('parseScutilOutput: HTTP + HTTPS proxy', () => {
  const r = parseScutilOutput(SCUTIL_HTTP_HTTPS)
  assert.equal(r.httpProxy, 'http://192.168.1.1:8080')
  assert.equal(r.httpsProxy, 'http://192.168.1.1:8443')
  assert.equal(r.pacUrl, null)
  assert.equal(r.enabled, true)
})

test('parseScutilOutput: PAC URL only', () => {
  const r = parseScutilOutput(SCUTIL_PAC)
  assert.equal(r.httpProxy, null)
  assert.equal(r.httpsProxy, null)
  assert.equal(r.pacUrl, 'http://wpad.example.com/proxy.pac')
  assert.equal(r.enabled, true)
})

test('parseScutilOutput: empty / invalid output', () => {
  for (const text of ['', '   ', null, undefined, 'not a dictionary at all', 'HTTPEnable : 1\n{']) {
    const r = parseScutilOutput(text)
    assert.equal(r.httpProxy, null, JSON.stringify(text))
    assert.equal(r.httpsProxy, null)
    assert.equal(r.pacUrl, null)
    assert.equal(r.enabled, false)
  }
})

test('parseScutilOutput: disabled flags win even with host present', () => {
  const r = parseScutilOutput(`<dictionary> {
  HTTPEnable : 0
  HTTPProxy : 192.168.1.1
  HTTPPort : 8080
  HTTPSEnable : 0
  HTTPSProxy : 10.0.0.5
  HTTPSPort : 3128
  ProxyAutoConfigEnable : 0
  ProxyAutoConfigURLString : http://x/proxy.pac
}`)
  assert.equal(r.httpProxy, null)
  assert.equal(r.httpsProxy, null)
  assert.equal(r.pacUrl, null)
  assert.equal(r.enabled, false)
})

test('parseScutilOutput: host without port still yields a URL', () => {
  const r = parseScutilOutput(`<dictionary> {
  HTTPEnable : 1
  HTTPProxy : proxy.corp
  HTTPSEnable : 1
  HTTPSProxy : proxy.corp
}`)
  assert.equal(r.httpProxy, 'http://proxy.corp')
  assert.equal(r.httpsProxy, 'http://proxy.corp')
  assert.equal(r.enabled, true)
})

test('formatProxyUrl: scheme preserved, port appended only when numeric', () => {
  assert.equal(formatProxyUrl('http://user:pass@proxy:8080', '8080'), 'http://user:pass@proxy:8080')
  assert.equal(formatProxyUrl('socks5://proxy:1080', '1080'), 'socks5://proxy:1080')
  assert.equal(formatProxyUrl('proxy.corp', 'not-a-port'), 'http://proxy.corp')
  assert.equal(formatProxyUrl('', '8080'), null)
})

test('detectFromEnv: uppercase HTTP_PROXY / HTTPS_PROXY / NO_PROXY', () => {
  const r = detectFromEnv({
    HTTP_PROXY: 'http://10.0.0.1:7890',
    HTTPS_PROXY: 'http://10.0.0.1:7890',
    NO_PROXY: 'localhost,127.0.0.1,.local',
  })
  assert.equal(r.httpProxy, 'http://10.0.0.1:7890')
  assert.equal(r.httpsProxy, 'http://10.0.0.1:7890')
  assert.equal(r.noProxy, 'localhost,127.0.0.1,.local')
  assert.equal(r.enabled, true)
})

test('detectFromEnv: lowercase vars and ALL_PROXY fallback', () => {
  const r = detectFromEnv({
    http_proxy: 'proxy.corp:3128',
    all_proxy: 'socks5://proxy.corp:1080',
    no_proxy: '',
  })
  assert.equal(r.httpProxy, 'http://proxy.corp:3128')
  assert.equal(r.httpsProxy, 'socks5://proxy.corp:1080')
  assert.equal(r.enabled, true)
})

test('detectFromEnv: nothing set means disabled', () => {
  const r = detectFromEnv({ PATH: '/usr/bin', HOME: '/root' })
  assert.equal(r.httpProxy, null)
  assert.equal(r.httpsProxy, null)
  assert.equal(r.pacUrl, null)
  assert.equal(r.enabled, false)
})
