/**
 * Minimal FML3 Handshake for Forge 1.20.1 (FML 47.x)
 * Based on analysis of actual server communication
 */

const ProtoDef = require('protodef').ProtoDef
const debug = require('debug')('minecraft-protocol-forge:minimal')

// FML3 Channels
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

// Load FML3 protocol definition
proto.addProtocol(require('./data/fml3.json'), ['fml3'])

/**
 * Minimal FML3 handshake to server.
 * @param {import('minecraft-protocol').Client} client client that is connecting to the server.
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

  // Set FML3 tag - this is critical!
  client.tagHost = '\0FML3\0'
  debug('initialized minimal FML3 handler')

  debug('modNames:', modNames.map(m => `${m.modid}:${m.version}`).join(', '))

  // Register the login wrapper channel
  client.registerChannel(FML_CHANNELS.LOGINWRAPPER, proto.types.fml_loginwrapper, false)

  // Remove default login_plugin_request listener
  const nmplistener = client.listeners('login_plugin_request').find((fn) => fn.name === 'onLoginPluginRequest')
  if (nmplistener) {
    client.removeListener('login_plugin_request', nmplistener)
  }

  // Handle login plugin request
  client.on('login_plugin_request', (data) => {
    if (data.channel === FML_CHANNELS.LOGINWRAPPER) {
      debug('Received login wrapper for channel:', data.channel, 'data length:', data.data.length)

      try {
        const { data: loginwrapper } = proto.parsePacketBuffer(
          PROTODEF_TYPES.LOGINWRAPPER,
          data.data
        )

        if (!loginwrapper.channel) {
          debug('No channel in login wrapper, ignoring')
          return
        }

        debug('Login wrapper channel:', loginwrapper.channel)

        if (loginwrapper.channel === FML_CHANNELS.HANDSHAKE) {
          const { data: handshake } = proto.parsePacketBuffer(
            PROTODEF_TYPES.HANDSHAKE,
            loginwrapper.data
          )

          debug('Handshake discriminator:', handshake.discriminator, 'data keys:', Object.keys(handshake.data || {}))

          // Handle ModList request
          if (handshake.discriminator === 'ModList') {
            const modlist = handshake.data

            debug('Server mod list:', modlist.modNames?.map(m => `${m.modid}:${m.version}`).join(', ') || 'none')

            // Build mod list reply
            const modlistreply = {
              modNames: modNames,
              channels: [],
              registries: []
            }

            // Add channels if provided
            if (Object.keys(channels).length > 0) {
              for (const channel in channels) {
                modlistreply.channels.push({
                  name: channel,
                  marker: channels[channel]
                })
              }
            }

            // Add registries if provided
            if (Object.keys(registries).length > 0) {
              for (const registry in registries) {
                modlistreply.registries.push({
                  name: registry,
                  marker: '1.0'
                })
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
          }

          // Handle ACK (acknowledgement)
          else if (handshake.discriminator === 'HandshakeAck') {
            debug('Received HandshakeAck')

            // Send ACK back
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

            debug('Sending HandshakeAck reply')
            client.write('custom_payload', {
              channel: FML_CHANNELS.LOGINWRAPPER,
              data: loginWrapperBuffer
            })
          }
        }
      } catch (err) {
        debug('Error processing login wrapper:', err.message)
      }
    }
  })

  // Handle error gracefully
  client.on('error', (err) => {
    debug('Client error:', err.message)
  })

  debug('FML3 minimal handshake handler registered')
}
