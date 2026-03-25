const ProtoDef = require('protodef').ProtoDef
const debug = require('debug')('minecraft-protocol-forge')

// Channels
const FML_CHANNELS = {
  LOGINWRAPPER: 'fml:loginwrapper',
  HANDSHAKE: 'fml:handshake'
}

const PROTODEF_TYPES = {
  LOGINWRAPPER: 'fml_loginwrapper',
  HANDSHAKE: 'fml_handshake'
}

// Initialize Proto
const proto = new ProtoDef(false)

// copied from ../../dist/transforms/serializer.js
proto.addType('string', [
  'pstring',
  {
    countType: 'varint'
  }
])

// copied from node-minecraft-protocol
proto.addTypes({
  restBuffer: [
    (buffer, offset) => {
      return {
        value: buffer.slice(offset),
        size: buffer.length - offset
      }
    },
    (value, buffer, offset) => {
      value.copy(buffer, offset)
      return offset + value.length
    },
    (value) => {
      return value.length
    }
  ]
})

proto.addProtocol(require('./data/fml3.json'), ['fml3'])

/**
 * FML 47.x handshake for Forge 1.20.1
 * Based on forgeHandshake3.js with 47.x enhancements
 *
 * Key 47.x features:
 * - 22+ registry synchronization messages
 * - Complex ModData handling
 * - Enhanced ACK tracking
 *
 * @param {import('minecraft-protocol').Client} client client that is connecting to the server.
 * @param {{
 *  forgeMods: Array.<{modid: string, version: string}> | undefined,
 *  channels: Object.<string, string> | undefined,
 *  registries: Object.<string, string> | undefined
 * }} options
 */
module.exports = function (client, options) {
  let modNames = options.forgeMods ? options.forgeMods.map(mod => {
    // Support both {modid, version} object format and string format
    if (typeof mod === 'object' && mod.modid) {
      return `${mod.modid}:${mod.version}`
    } else if (typeof mod === 'string') {
      return mod
    } else {
      return String(mod) // fallback
    }
  }) : []
  const channels = options.channels
  const registries = options.registries

  // passed to src/client/setProtocol.js, signifies client supports FML3/Forge
  client.tagHost = '\0FML3\0'

  // SOLUTION A: Protect tagHost from being cleared or modified during handshake
  // This prevents the server from losing track of our Forge identity
  const originalTagHost = client.tagHost
  const savedTagHost = '\0FML3\0'

  debug('initialized FML 47.x handler (based on forgeHandshake3.js)')
  debug('tagHost protected:', JSON.stringify(savedTagHost))

  // Track handshake state for 47.x
  const handshakeState = {
    registrySequence: 0,
    registriesReceived: 0,
    totalRegistries: 22, // Typical for 1.20.1
    modListSent: false,
    loginPluginRequestCount: 0
  }
  if (!modNames) {
    debug("trying to guess modNames by reflecting the servers'")
  } else {
    debug('modNames:', modNames)
  }
  if (!channels) {
    debug("trying to guess channels by reflecting the servers'")
  } else {
    Object.entries(channels).forEach((name, marker) => {
      debug('channel', name, marker)
    })
  }
  if (!registries) {
    debug("trying to guess registries by reflecting the servers'")
  } else {
    Object.entries(registries).forEach((name, marker) => {
      debug('registry', name, marker)
    })
  }

  client.registerChannel('fml:loginwrapper', proto.types.fml_loginwrapper, false)

  // Verify tagHost after registerChannel (known to potentially clear it)
  if (client.tagHost !== savedTagHost) {
    debug('WARNING: tagHost was modified after registerChannel, restoring:', JSON.stringify(savedTagHost))
    client.tagHost = savedTagHost
  }

  // remove default login_plugin_request listener which would answer with an empty packet
  // and make the server disconnect us
  const nmplistener = client.listeners('login_plugin_request').find((fn) => fn.name === 'onLoginPluginRequest')
  client.removeListener('login_plugin_request', nmplistener)

  client.on('login_plugin_request', (data) => {
    // CRITICAL: Verify tagHost before processing any Forge handshake messages
    if (client.tagHost !== savedTagHost) {
      debug('CRITICAL: tagHost was lost before login_plugin_request, restoring:', JSON.stringify(savedTagHost))
      client.tagHost = savedTagHost
    }

    debug(`=== Received login_plugin_request #${++handshakeState.loginPluginRequestCount || 1} ===`)
    debug(`  Channel: "${data.channel}"`)
    debug(`  Message ID: ${data.messageId}`)
    debug(`  Data length: ${data.data ? data.data.length : 0} bytes`)

    if (data.channel === 'fml:loginwrapper') {
      debug('  ↳ Channel is fml:loginwrapper, parsing...')

      // parse buffer
      let loginwrapper
      try {
        ({ data: loginwrapper } = proto.parsePacketBuffer(
          PROTODEF_TYPES.LOGINWRAPPER,
          data.data
        ))
      } catch (err) {
        debug(`  ❌ Failed to parse loginwrapper: ${err.message}`)
        debug(`  Data length: ${data.data.length}, hex: ${data.data.toString('hex').substring(0, 64)}`)
        return
      }

      if (!loginwrapper.channel) {
        debug('  ❌ loginwrapper.channel is missing/undefined!')
        console.error(loginwrapper)
      } else {
        debug(`  ↳ Parsed loginwrapper channel: "${loginwrapper.channel}"`)
      }

      switch (loginwrapper.channel) {
        case 'fml:handshake': {
          let handshake
          try {
            ({ data: handshake } = proto.parsePacketBuffer(
              PROTODEF_TYPES.HANDSHAKE,
              loginwrapper.data
            ))
          } catch (err) {
            debug(`  ❌ Failed to parse handshake: ${err.message}`)
            debug(`  Loginwrapper data length: ${loginwrapper.data.length}, hex: ${loginwrapper.data.toString('hex').substring(0, 64)}`)

            // ServerRegistry packets often fail to parse due to snapshot structure issues
            // Send Acknowledgement anyway to continue handshake
            const ackData = {
              discriminator: 'Acknowledgement',
              data: {}
            }
            const ackPacket = proto.createPacketBuffer(PROTODEF_TYPES.HANDSHAKE, ackData)
            const ackWrapper = proto.createPacketBuffer(
              PROTODEF_TYPES.LOGINWRAPPER,
              {
                channel: FML_CHANNELS.HANDSHAKE,
                data: ackPacket
              }
            )
            client.write('login_plugin_response', {
              messageId: data.messageId,
              data: ackWrapper
            })
            debug('  ↳ Sent Acknowledgement despite parse error')
            return
          }

          debug(`  ↳ Handshake discriminator: "${handshake.discriminator}"`)

          let loginwrapperpacket = Buffer.alloc(0)
          switch (handshake.discriminator) {
            // respond with ModListResponse
            case 'ModList': {
              const modlist = handshake.data
              debug('Server requested mod list')
              debug('Server modlist.registries sample:', modlist.registries?.slice(0, 3))
              debug('Server modlist.registries has marker?', !!modlist.registries?.[0]?.marker)
              debug('Server modlist.channels sample:', modlist.channels?.slice(0, 2))

              const modlistreply = {
                modNames,
                channels: [],
                registries: []
              }

              // FML 47.x: Mark that mod list has been sent
              handshakeState.modListSent = true
              debug('Preparing ModList reply')

              if (!options.modNames) {
                modlistreply.modNames = modlist.modNames
              }

              if (!options.channels) {
                // FML 47.x: Reflect ALL server channels with exact markers
                // Do NOT filter channels - server expects exact match

                for (const { name, marker } of modlist.channels) {
                  modlistreply.channels.push({ name, marker })
                }
              } else {
                for (const channel in channels) {
                  modlistreply.channels.push({
                    name: channel,
                    marker: channels[channel].marker
                  })
                }
              }

              if (!options.registries) {
                for (const { name, marker } of modlist.registries) {
                  // Server doesn't send marker - use empty string to indicate "current version"
                  modlistreply.registries.push({ name, marker: marker || '' })
                }
              } else {
                for (const registry in registries) {
                  modlistreply.registries.push({
                    name: registry,
                    marker: registries[registry]
                  })
                }
              }

              debug(`ModList reply: ${modlistreply.modNames?.length || 0} mods, ${modlistreply.channels.length} channels, ${modlistreply.registries.length} registries`)

              // Create packet with discriminator
              const modlistreplyData = {
                discriminator: 'ModListReply',
                data: modlistreply
              }

              debug(`Creating ModListReply packet with discriminator: "${modlistreplyData.discriminator}"`)
              debug(`ModListReply data:`, modlistreplyData)

              const modlistreplypacket = proto.createPacketBuffer(
                PROTODEF_TYPES.HANDSHAKE,
                modlistreplyData
              )

              debug(`ModListReply packet created: ${modlistreplypacket.length} bytes`)
              debug(`Packet hex (first 32 bytes): ${modlistreplypacket.slice(0, 32).toString('hex')}`)
              debug(`Full packet structure:`, modlistreplyData)

              loginwrapperpacket = proto.createPacketBuffer(
                PROTODEF_TYPES.LOGINWRAPPER,
                {
                  channel: FML_CHANNELS.HANDSHAKE,
                  data: modlistreplypacket
                }
              )

              debug('Sending ModList reply to server')
              break
            }

            // this shouldn't happen
            case 'ModListReply':
              throw Error('received clientbound-only ModListReply from server')

            // respond with Ack
            case 'ServerRegistry': {
              // FML 47.x: Server sends registry data
              const serverRegistry = handshake.data
              debug(`Received ServerRegistry: ${serverRegistry.name || 'unnamed'}`)
              handshakeState.registriesReceived++

              const ackData = {
                discriminator: 'Acknowledgement',
                data: {}
              }

              debug(`Sending Acknowledgement packet with discriminator: "${ackData.discriminator}"`)

              loginwrapperpacket = proto.createPacketBuffer(
                PROTODEF_TYPES.LOGINWRAPPER,
                {
                  channel: FML_CHANNELS.HANDSHAKE,
                  data: proto.createPacketBuffer(PROTODEF_TYPES.HANDSHAKE, ackData)
                }
              )
              break
            }

            // respond with Ack
            case 'ConfigurationData': {
              loginwrapperpacket = proto.createPacketBuffer(
                PROTODEF_TYPES.LOGINWRAPPER,
                {
                  channel: FML_CHANNELS.HANDSHAKE,
                  data: proto.createPacketBuffer(PROTODEF_TYPES.HANDSHAKE, {
                    discriminator: 'Acknowledgement',
                    data: {}
                  })
                }
              )
              break
            }

            // respond with Ack
            case 'ModData': {
              // FML 47.x: Track registry synchronization
              const modData = handshake.data
              debug(`Received ModData (registry sequence ${handshakeState.registrySequence})`)
              handshakeState.registriesReceived++
              handshakeState.registrySequence++

              // Log progress
              if (handshakeState.registriesReceived <= handshakeState.totalRegistries) {
                debug(`Registry sync progress: ${handshakeState.registriesReceived}/${handshakeState.totalRegistries}`)
              }

              loginwrapperpacket = proto.createPacketBuffer(
                PROTODEF_TYPES.LOGINWRAPPER,
                {
                  channel: FML_CHANNELS.HANDSHAKE,
                  data: proto.createPacketBuffer(PROTODEF_TYPES.HANDSHAKE, {
                    discriminator: 'Acknowledgement',
                    data: {}
                  })
                }
              )

              // Check if all registries received
              if (handshakeState.registriesReceived >= handshakeState.totalRegistries) {
                debug('All registries synchronized, handshake phase complete')
              }
              break
            }

            // respond with Ack ?
            case 'ChannelMismatchData': {
              debug('Received ChannelMismatchData, sending Acknowledgement...')
              loginwrapperpacket = proto.createPacketBuffer(
                PROTODEF_TYPES.LOGINWRAPPER,
                {
                  channel: FML_CHANNELS.HANDSHAKE,
                  data: proto.createPacketBuffer(PROTODEF_TYPES.HANDSHAKE, {
                    discriminator: 'Acknowledgement',
                    data: {}
                  })
                }
              )
              debug(`Acknowledgement packet created: ${loginwrapperpacket.length} bytes`)
              debug('Sending login_plugin_response...')
              client.write('login_plugin_response', {
                messageId: data.messageId,
                data: loginwrapperpacket
              })
              debug('login_plugin_response sent successfully')
              break
            }

            // this shouldn't happen
            case 'Acknowledgement':
              throw Error('received clientbound-only Acknowledgement from server')
          }

          client.write('login_plugin_response', {
            messageId: data.messageId,
            data: loginwrapperpacket
          })
          break
        }

        default:
          debug(`Unknown loginwrapper channel: "${loginwrapper.channel}"`)
          try {
            debug('Sending Acknowledgement packet for unknown channel')
            const ackData = {
              discriminator: 'Acknowledgement',
              data: {}
            }
            const acknowledgementPacket = proto.createPacketBuffer(PROTODEF_TYPES.HANDSHAKE, ackData)
            loginwrapperpacket = proto.createPacketBuffer(
              PROTODEF_TYPES.LOGINWRAPPER,
              {
                channel: FML_CHANNELS.HANDSHAKE,
                data: acknowledgementPacket
              }
            )
            client.write('login_plugin_response', {
              messageId: data.messageId,
              data: loginwrapperpacket
            })
            debug(`Unknown channel response: ${acknowledgementPacket.length} bytes handshake + ${loginwrapperpacket.length} bytes wrapper`)
          } catch (error) {
            debug(`Error handling unknown channel: ${error.message}`)
            console.error(error)
          }
          break
      }
    } else {
      console.log('other channel', data.channel, 'received')
    }
  })
}
