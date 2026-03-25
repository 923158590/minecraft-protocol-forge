# minecraft-protocol-forge
[![NPM version](https://img.shields.io/npm/v/minecraft-protocol-forge.svg)](http://npmjs.com/package/minecraft-protocol-forge)
[![Join the chat at https://gitter.im/PrismarineJS/node-minecraft-protocol](https://img.shields.io/badge/gitter-join%20chat-brightgreen.svg)](https://gitter.im/PrismarineJS/node-minecraft-protocol)

Adds FML/Forge support to [node-minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) (requires 0.17+)

## Features

* Supports the `FML|HS` client handshake
* Adds automatic Forge mod detection to node-minecraft-protocol's auto-versioning

## Usage

Installable as a plugin for use with node-minecraft-protocol:

```javascript
var mc = require('minecraft-protocol');
var forgeHandshake = require('minecraft-protocol-forge').forgeHandshake;
var client = mc.createClient({
    host: host,
    port: port,
    username: username,
    password: password
});

forgeHandshake(client, {forgeMods: [
  { modid: 'mcp', version: '9.18' },
  { modid: 'FML', version: '8.0.99.99' },
  { modid: 'Forge', version: '11.15.0.1715' },
  { modid: 'IronChest', version: '6.0.121.768' }
]});
```

The `forgeMods` option is an array of modification identifiers and versions to present
to the server. Servers will kick the client if they do not have the required mods.

To automatically present the list of mods offered by the server, the `autoVersionForge`
plugin for node-minecraft-protocol's `autoVersion` (activated by `version: false`) can
be used:

```javascript
var mc = require('minecraft-protocol');
var autoVersionForge = require('minecraft-protocol-forge').autoVersionForge;
var client = mc.createClient({
    version: false,
    host: host,
    port: port,
    username: username,
    password: password
});

autoVersionForge(client);
```

This will automatically install the `forgeHandshake` plugin, with the appropriate mods,
if the server advertises itself as Forge/FML. Useful for connecting to servers you don't
know if they are Forge or not, or what mods they are using.

## Installation

`npm install minecraft-protocol-forge`

## Debugging

You can enable some protocol debugging output using `NODE_DEBUG` environment variable:

```bash
NODE_DEBUG="minecraft-protocol-forge" node [...]
```

---

## 🔧 BProtocol 项目修改说明

此版本由 [BProtocol](https://github.com/923158590/BProtocol) 项目修改，修复了与 Minecraft 1.20.1 Forge 服务器的关键握手问题。

### 📋 主要修复内容

#### 1. Registry Marker 处理 (第 206-210 行)
**问题**: 服务器发送的 ModList 中 registry 对象只包含 `{name}`，不包含 `marker` 字段。

**修复**: 使用空字符串作为 fallback 表示"当前版本"，而不是硬编码 `'1.0'`。

```javascript
// 修复前（错误）
modlistreply.registries.push({ name, marker: '1.0' })  // 导致 "unexpected index 0" 错误

// 修复后（正确）
modlistreply.registries.push({ name, marker: marker || '' })  // 空字符串表示当前版本
```

#### 2. Channel 过滤逻辑 (第 190-196 行)
**问题**: 原始代码错误地过滤掉了 FML3 标记的 channels，导致握手不完整。

**修复**: 移除 channel 过滤逻辑，完全镜像服务器的所有 channels。

```javascript
// 修复前（错误）- 只发送 2 个 channels
if (marker !== 'FML3') {  // 错误逻辑！排除了 FML3 channels
  if (name.length > MAX_CHANNEL_LENGTH) continue
  modlistreply.channels.push({ name, marker })
}

// 修复后（正确）- 发送全部 13 个 channels
modlistreply.channels.push({ name, marker })  // 完全镜像服务器
```

#### 3. ServerRegistry 解析容错 (第 165-196 行)
**问题**: FML3 协议的 `forge_snapshot` 结构复杂，服务器发送的 ServerRegistry 数据包经常因 `snapshot.dummied.$count` 字段解析失败。

**修复**: 添加 try-catch，在解析失败时仍发送 Acknowledgement 继续握手。

```javascript
try {
  ({ data: handshake } = proto.parsePacketBuffer(...))
} catch (err) {
  debug(`❌ Failed to parse handshake: ${err.message}`)

  // 无论如何发送 Acknowledgement 以继续握手
  const ackData = { discriminator: 'Acknowledgement', data: {} }
  // ... 发送 acknowledgement
  debug('↳ Sent Acknowledgement despite parse error')
  return
}
```

### 📊 测试结果对比

**修复前**:
```
ModList reply: 5 mods, 2 channels, 19 registries
ModListReply packet: 611 bytes
❌ EPIPE 错误 - "Channels rejected their client side version number"
```

**修复后**:
```
ModList reply: 5 mods, 13 channels, 19 registries
ModListReply packet: 927 bytes
✅ TestBot joined the game - Entity ID: 8661
```

**改进效果**:
- Channels: 2 → 13 (+550%)
- 数据包大小: 611 → 927 bytes (+52%)
- 结果: EPIPE 连接错误 → ✅ 成功登录

### ✅ 已验证兼容性

- ✅ **Forge 1.20.1** 服务器（测试日期: 2026-02-13）
- ✅ **Bot 成功加入游戏**，获得 Entity ID
- ✅ **18 秒连接时间**，握手稳定
- ✅ **13 个 channels** 与服务器正确同步

### 📝 修改的文件

- `src/client/forgeHandshake3_47x_v2.js` (+35 行, -10 行)
  - 第 165-196 行: ServerRegistry 解析容错
  - 第 190-196 行: 移除 channel 过滤
  - 第 206-210 行: Registry marker fallback

### 🔗 相关文档

详细技术分析请参考:
- [Forge 集成成功报告](https://github.com/923158590/BProtocol/tree/main/nodejs/docs/forge/SUCCESS_REPORT.md)
- [经验教训总结](https://github.com/923158590/BProtocol/tree/main/nodejs/docs/forge/LESSONS_LEARNED.md)
- [根本原因分析](https://github.com/923158590/BProtocol/tree/main/nodejs/docs/forge/ROOT_CAUSE_ANALYSIS.md)

### 🎯 在 BProtocol 中的使用

此版本用于 BProtocol Minecraft 机器人控制系统，以连接到 Forge 模组服务器。这些修复确保了机器人在 Forge 1.20.1 服务器上可靠运行。

**BProtocol 仓库**: https://github.com/923158590/BProtocol

---

## 📅 更新日志

### v1.0-bprotocol (2026-02-13)
- ✅ 修复 FML3 握手的 Registry marker 处理
- ✅ 移除 channel 过滤以镜像所有服务器 channels
- ✅ 添加 ServerRegistry 解析容错机制
- ✅ 验证与 Forge 1.20.1 服务器的兼容性
- ✅ 使用僵尸感知模组和其他自定义模组测试通过
