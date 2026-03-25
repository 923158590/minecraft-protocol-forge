/**
 * FML 47.x Handshake for Forge 1.20.1
 * Based on analysis of server communication logs
 *
 * Key differences from FML 1.x/2.x:
 * - Channel names: fml:handshake, fml:loginwrapper (not FML|HS, FML)
 * - More complex registry synchronization
 * - 22 messages in handshake flow
 * - S2CModData contains actual mod list
 */

const ProtoDef = require('protodef').ProtoDef
const debug = require('debug')('minecraft-protocol-forge:47x')

// FML 47.x Channels
const FML_CHANNELS = {
  LOGINWRAPPER: 'fml:loginwrapper',
  HANDSHAKE: 'fml:handshake',
  PLAY: 'fml:play'
}

const PROTODEF_TYPES = {
  LOGINWRAPPER: 'fml_loginwrapper',
  HANDSHAKE: 'fml_handshake'
}

// Initialize ProtoDef
const proto = new ProtoDef(false)

// Add required types
proto.addType('string', [
  'pstring',
  {
    countType: 'varint'
  }
])

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

// Load FML3 protocol definition (will need to be enhanced for 47.x)
proto.addProtocol(require('./data/fml3.json'), ['fml3'])

/**
 * FML 47.x handshake implementation
 * @param {import('minecraft-protocol').Client} client
 * @param {{
 *  forgeMods: Array.<{modid: string, version: string}>,
 *  channels: Object.<string, string> | undefined,
 *  registries: Object.<string, string> | undefined
 * }} options
 */
module.exports = function (client, options) {
  const modNames = options.forgeMods || []
  const channels = options.channels || {}
  const registries = options.registries || {}

  // Set FML3 tag - CRITICAL for server recognition
  client.tagHost = '\0FML3\0'
  debug('initialized FML 47.x handler')

  debug('modNames:', modNames.map(m => `${m.modid}:${m.version}`).join(', '))

  // Register the login wrapper channel
  client.registerChannel(FML_CHANNELS.LOGINWRAPPER, proto.types.fml_loginwrapper, false)

  // Remove default login_plugin_request listener
  const nmplistener = client.listeners('login_plugin_request').find((fn) => fn.name === 'onLoginPluginRequest')
  if (nmplistener) {
    client.removeListener('login_plugin_request', nmplistener)
  }

  // Track handshake state
  let handshakeState = {
    sequence: 0,
    modListSent: false,
    registriesReceived: 0,
    totalRegistries: 22  // Based on server logs
  }

  // Handle login plugin request
  client.on('login_plugin_request', (data) => {
    if (data.channel === FML_CHANNELS.LOGINWRAPPER) {
      debug(`Received login wrapper (data length: ${data.data.length})`)

      try {
        const { data: loginwrapper } = proto.parsePacketBuffer(
          PROTODEF_TYPES.LOGINWRAPPER,
          data.data
        )

        if (!loginwrapper.channel) {
          debug('No channel in login wrapper')
          return
        }

        debug(`Login wrapper channel: ${loginwrapper.channel}`)

        if (loginwrapper.channel === FML_CHANNELS.HANDSHAKE) {
          const { data: handshake } = proto.parsePacketBuffer(
            PROTODEF_TYPES.HANDSHAKE,
            loginwrapper.data
          )

          debug(`Handshake discriminator: ${handshake.discriminator}`)

          // Handle S2CModList (Server sends mod list request)
          if (handshake.discriminator === 'ModList') {
            const modlist = handshake.data
            debug('Server requested mod list')

            // Build mod list reply with server's mod list if available
            const modlistreply = {
              modNames: modNames,
              channels: [],
              registries: []
            }

            // Add channels if server sent them
            if (modlist.channels) {
              for (const { name, marker } of modlist.channels) {
                if (marker !== 'FML3') {
                  modlistreply.channels.push({ name, marker })
                }
              }
            }

            // Add registries if server sent them
            if (modlist.registries) {
              for (const { name } of modlist.registries) {
                modlistreply.registries.push({ name, marker: '1.0' })
              }
            }

            const replyBuffer = proto.createPacketBuffer(
              PROTODEF_TYPES.HANDSHAKE,
              'ModList',
              modlistreply
            )

            const loginWrapperBuffer = proto.createPacketBuffer(
              PROTODEF_TYPES.LOGINWRAPPER,
              {
                channel: FML_CHANNELS.HANDSHAKE,
                data: replyBuffer
              }
            )

            debug('Sending ModList reply')
            client.write('custom_payload', {
              channel: FML_CHANNELS.LOGINWRAPPER,
              data: loginWrapperBuffer
            })

            handshakeState.modListSent = true
          }

          // Handle S2CModData (Server sends registry data)
          else if (handshake.discriminator === 'ModData') {
            const modData = handshake.data
            debug(`Received ModData (sequence ${handshakeState.sequence})`)
            handshakeState.registriesReceived++

            // Send ACK for each registry packet
            if (handshakeState.registriesReceived < handshakeState.totalRegistries) {
              const ackBuffer = proto.createPacketBuffer(
                PROTODEF_TYPES.HANDSHAKE,
                'HandshakeAck',
                { accepted: true }
              )

              const loginWrapperBuffer = proto.createPacketBuffer(
                PROTODEF_TYPES.LOGINWRAPPER,
                {
                  channel: FML_CHANNELS.HANDSHAKE,
                  data: ackBuffer
                }
              )

              client.write('custom_payload', {
                channel: FML_CHANNELS.LOGINWRAPPER,
                data: loginWrapperBuffer
              })

              handshakeState.sequence++
              debug(`Sent ACK ${handshakeState.registriesReceived}`)
            }

            // After all registries, handshake is complete
            if (handshakeState.registriesReceived >= handshakeState.totalRegistries) {
              debug('All registries received, handshake complete')
            }
          }

          // Handle HandshakeAck
          else if (handshake.discriminator === 'HandshakeAck') {
            debug('Received HandshakeAck')
            // No action needed on client side
          }
        }
      } catch (err) {
        debug(`Error processing login wrapper: ${err.message}`)
        debug(err.stack)
      }
    }
  })

  client.on('error', (err) => {
    debug('Client error:', err.message)
  })

  debug('FML 47.x handshake handler registered')
}
