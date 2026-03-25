/**
 * FML 47.x Complete Handshake Implementation
 * Based on packet capture and protocol analysis
 */

const ProtoDef = require('protodef').ProtoDef
const debug = require('debug')('minecraft-protocol-forge:fml47x')

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

// Load FML 47.x protocol definition using addProtocol (same as forgeHandshake3)
proto.addProtocol(require('./data/fml47x_final_v2.json'), ['fml47x'])

debug('FML 47.x protocol loaded via addProtocol')

/**
 * FML 47.x complete handshake
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

  // Handshake state machine
  const STATE = {
    START: 0,
    MODLIST_SENT: 1,
    REGISTRY_SYNC: 2,
    COMPLETE: 3
  }

  let currentState = STATE.START
  let registryCount = 0
  const EXPECTED_REGISTRIES = 22  // Based on server logs

  // Handle login plugin request
  client.on('login_plugin_request', (data) => {
    if (data.channel === FML_CHANNELS.LOGINWRAPPER) {
      debug(`[State ${currentState}] Received login wrapper (data length: ${data.data.length})`)

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

          // Handle S2CModList (server requests mod list)
          if (handshake.discriminator === 'ModList') {
            const modlist = handshake.data
            debug('Server sent ModList request')
            debug(`Server mod list: ${modlist.modNames?.map(m => m.modid).join(', ') || 'none'}`)

            // Build mod list reply
            const modlistreply = {
              modNames: modNames,
              channels: [],
              registries: []
            }

            // Copy server's channel list (excluding FML3)
            if (modlist.channels) {
              for (const { name, marker } of modlist.channels) {
                if (marker !== 'FML3') {
                  modlistreply.channels.push({ name, marker })
                }
              }
            }

            // Copy server's registry list
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

            debug('Sending C2SModList reply')
            client.write('custom_payload', {
              channel: FML_CHANNELS.LOGINWRAPPER,
              data: loginWrapperBuffer
            })

            currentState = STATE.MODLIST_SENT
            debug('State -> MODLIST_SENT')
          }

          // Handle S2CModData (server sends registry data)
          else if (handshake.discriminator === 'ModData') {
            const registryName = handshake.data.registryName
            debug(`Received ModData: ${registryName} (registry #${registryCount + 1}/${EXPECTED_REGISTRIES})`)

            // Send ACK for each registry packet
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

            registryCount++
            currentState = STATE.REGISTRY_SYNC

            // Check if all registries received
            if (registryCount >= EXPECTED_REGISTRIES) {
              debug('All registries received, handshake complete!')
              currentState = STATE.COMPLETE
            }
          }

          // Handle HandshakeAck
          else if (handshake.discriminator === 'HandshakeAck') {
            debug('Received HandshakeAck')
            // No action needed
          }
          else {
            debug(`Unknown discriminator: ${handshake.discriminator}`)
          }
        }
      } catch (err) {
        debug(`Error processing login wrapper: ${err.message}`)
        debug(`Data (hex): ${data.data.toString('hex').substring(0, 200)}`)
        debug(err.stack)
      }
    }
  })

  client.on('error', (err) => {
    debug('Client error:', err.message)
  })

  debug('FML 47.x handshake handler registered (complete implementation)')
}
