// Copyright Epic Games, Inc. All Rights Reserved.
import express from 'express';
import fs from 'fs';
import path from 'path';
import {
    SignallingServer,
    IServerConfig,
    WebServer,
    InitLogging,
    Logger,
    IWebServerConfig
} from '@epicgames-ps/lib-pixelstreamingsignalling-ue5.8';
import { beautify, IProgramOptions } from './Utils';
import { createTurnCredentialsProvider, hasCredentiallessTurnServer } from './turnCredentials';
import { BackendIceServers } from './backendIceServers';
import { limitSessionLength } from './sessionLimits';
import { attachOnDemandUnreal, createOnDemandUnreal } from './onDemandUnreal';
import { initInputHandler } from './InputHandler';
import { Command, Option } from 'commander';
import { initialize } from 'express-openapi';
import configHandler from './paths/config';
import playersHandler from './paths/players';
import playerByIdHandler from './paths/players/{playerId}';
import statusHandler from './paths/status';
import streamersHandler from './paths/streamers';
import streamerByIdHandler from './paths/streamers/{streamerId}';

// eslint-disable-next-line  @typescript-eslint/no-unsafe-assignment
const pjson = require('../package.json');

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
// possible config file options
let config_file: IProgramOptions = {};
const configArgsParser = new Command()
    .option('--no_config', 'Skips the reading of the config file. Only CLI options will be used.', false)
    .option(
        '--config_file <path>',
        'Sets the path of the config file.',
        `${path.resolve(__dirname, '..', 'config.json')}`
    )
    .helpOption(false)
    .allowUnknownOption() // ignore unknown options as we are doing a minimal parse here
    .parse()
    .opts();
// If we do not get passed `--no_config` then attempt open the config file
if (!configArgsParser.no_config) {
    try {
        if (fs.existsSync(configArgsParser.config_file)) {
            console.log(`Config file configured as: ${configArgsParser.config_file}`);
            const configData = fs.readFileSync(configArgsParser.config_file, { encoding: 'utf8' });
            config_file = JSON.parse(configData);
        } else {
            // Even though proper logging is not intialized, logging here is better than nothing.
            console.log(`No config file found at: ${configArgsParser.config_file}`);
        }
    } catch (error: unknown) {
        console.error(error);
    }
}

const program = new Command();
program
    .name('node dist/index.js')
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    .description(pjson.description)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    .version(pjson.version);

// For any switch that doesn't take an argument, like --serve, its important to give it a default value.
// Without the default, not supplying the default will mean the option is `undefined` in
// `cli_option`s` and loading from the configuration file will not work as intended.
// The way the configuration file works is that if it is found it will parsed for key/values that match
// the argument names specified below. If one is found it will become the new default value for that option.
// This allow the user to have values in the configuration file but also override them by specifying an argument on the command line.
program
    .option('--log_folder <path>', 'Sets the path for the log files.', config_file.log_folder || 'logs')
    .addOption(
        new Option('--log_level_console <level>', 'Sets the logging level for console messages.')
            .choices(['debug', 'info', 'warning', 'error'])
            .default(config_file.log_level_console || 'info')
    )
    .addOption(
        new Option('--log_level_file <level>', 'Sets the logging level for log files.')
            .choices(['debug', 'info', 'warning', 'error'])
            .default(config_file.log_level_file || 'info')
    )
    .addOption(
        new Option(
            '--console_messages [detail]',
            'Displays incoming and outgoing signalling messages on the console.'
        )
            .choices(['basic', 'verbose', 'formatted'])
            .preset(config_file.console_messages || 'basic')
    )
    .option(
        '--streamer_port <port>',
        'Sets the listening port for streamer connections.',
        config_file.streamer_port || '8888'
    )
    .option(
        '--streamer_host <address>',
        'Address the streamer port listens on. Anyone who can reach it can register as a streamer, so set 127.0.0.1 when the streamer runs on this machine. Default: all interfaces.',
        config_file.streamer_host
    )
    .option(
        '--player_port <port>',
        'Sets the listening port for player connections.',
        config_file.player_port || '80'
    )
    .option(
        '--sfu_port <port>',
        'Sets the listening port for SFU connections.',
        config_file.sfu_port || '8889'
    )
    .option(
        '--max_players <number>',
        'Sets the maximum number of subscribers per streamer. 0 = unlimited',
        config_file.max_players || '0'
    )
    .option(
        '--player_keepalive_timeout <milliseconds>',
        'Disconnect a player after this many milliseconds without a keepalive response. 0 = disabled',
        config_file.player_keepalive_timeout || '30000'
    )
    .option('--serve', 'Enables the webserver on player_port.', config_file.serve || false)
    .option(
        '--http_root <path>',
        'Sets the path for the webserver root.',
        config_file.http_root || `${path.resolve(__dirname, '..', 'www')}`
    )
    .option(
        '--homepage <filename>',
        'The default html file to serve on the web server.',
        config_file.homepage || 'player.html'
    )
    .option('--https', 'Enables the webserver on https_port and enabling SSL', config_file.https || false)
    .addOption(
        new Option('--https_port <port>', 'Sets the listen port for the https server.')
            .implies({ https: true })
            .default(config_file.https_port || 443)
    )
    .option(
        '--ssl_key_path <path>',
        'Sets the path for the SSL key file.',
        config_file.ssl_key_path || 'certificates/client-key.pem'
    )
    .option(
        '--ssl_cert_path <path>',
        'Sets the path for the SSL certificate file.',
        config_file.ssl_cert_path || 'certificates/client-cert.pem'
    )
    .option(
        '--https_redirect',
        'Enables the redirection of connection attempts on http to https. If this is not set the webserver will only listen on https_port. Player websockets will still listen on player_port.',
        config_file.https_redirect || false
    )
    .option(
        '--rest_api',
        'Enables the rest API interface that can be accessed at <server_url>/api/api-definition',
        config_file.rest_api || false
    )
    .option(
        '--cors',
        'Enables CORS headers on the webserver. Required for browser-based clients hosted on a different origin to call routes such as the REST API.',
        config_file.cors || false
    )
    .option(
        '--cors_allowed_origins <origins>',
        'Comma-separated list of allowed origins (e.g. "https://example.com,https://other.example.com"). If omitted, all origins are allowed.',
        config_file.cors_allowed_origins || ''
    )
    .option(
        '--cors_allowed_methods <methods>',
        'Comma-separated list of allowed HTTP methods. Defaults to the cors middleware default if omitted.',
        config_file.cors_allowed_methods || ''
    )
    .option(
        '--cors_allowed_headers <headers>',
        "Comma-separated list of allowed request headers. If omitted, the request's Access-Control-Request-Headers value is mirrored.",
        config_file.cors_allowed_headers || ''
    )
    .option(
        '--cors_credentials',
        'Allow credentials (cookies, authorization headers) on cross-origin requests.',
        config_file.cors_credentials || false
    )
    .addOption(
        new Option(
            '--peer_options <json-string>',
            'Additional JSON data to send in peerConnectionOptions of the config message.'
        )
            .argParser(JSON.parse)
            .default(config_file.peer_options || '')
    )
    .addOption(
        new Option(
            '--peer_options_file <filename>',
            'Additional JSON data to send in peerConnectionOptions of the config message. This allows you to provide JSON data without having to deal with it on the command line.'
        ).default(config_file.peer_options_file || '')
    )
    .addOption(
        new Option(
            '--turn_secret <secret>',
            'Shared secret for time limited TURN credentials, matching static-auth-secret on the TURN server. When set, the username and credential of every turn: entry in the peer options are replaced with a freshly minted pair for each peer that connects.'
        ).default(config_file.turn_secret || '')
    )
    .addOption(
        new Option(
            '--turn_secret_file <filename>',
            'Reads the value of --turn_secret from a file, so the secret does not appear in the command line of this process.'
        ).default(config_file.turn_secret_file || '')
    )
    .option(
        '--turn_ttl <seconds>',
        'How long a credential issued to a player stays valid. Streamers and SFUs are configured once and cannot be reissued, so they are given a credential that does not practically expire.',
        config_file.turn_ttl || '86400'
    )
    .option(
        '--backend_ice_url <url>',
        'Takes the ICE servers (STUN and TURN) from a backend instead of a TURN server configured here, e.g. http://127.0.0.1:5000/movement_analysis/ice_servers. The API key comes from --backend_ice_key_file or the BACKEND_API_KEY environment variable. Cannot be combined with --turn_secret.',
        config_file.backend_ice_url || ''
    )
    .option(
        '--backend_ice_key_file <filename>',
        'Reads the API key for --backend_ice_url from a file, so it does not appear in the command line of this process.',
        config_file.backend_ice_key_file || ''
    )
    .option(
        '--unreal_start_cmd <command>',
        'Runs Unreal on demand, one fresh instance per viewer, with a waiting line. This command starts Unreal (it need not wait until Unreal has registered). Needs --unreal_stop_cmd.',
        config_file.unreal_start_cmd || ''
    )
    .option(
        '--unreal_stop_cmd <command>',
        'The command that stops Unreal and returns when it has gone. Run when the viewer who was watching leaves, and when nobody is watching or waiting.',
        config_file.unreal_stop_cmd || ''
    )
    .option(
        '--unreal_start_timeout <seconds>',
        'A start after which no streamer registers within this time counts as failed and is stopped.',
        config_file.unreal_start_timeout || '60'
    )
    .option(
        '--unreal_min_start_gap <seconds>',
        'The least time between two starts of Unreal.',
        config_file.unreal_min_start_gap || '10'
    )
    .option(
        '--unreal_turn_timeout <seconds>',
        'How long the first in line has to take its turn before the next one is offered it.',
        config_file.unreal_turn_timeout || '30'
    )
    .option(
        '--unreal_grace_seconds <seconds>',
        'How long a viewer that has disconnected keeps its place in line, so a reload of its page does not send it to the back.',
        config_file.unreal_grace_seconds || '30'
    )
    .option(
        '--unreal_return_seconds <seconds>',
        'How long the viewer who was being served keeps the first place after it leaves, so that reloading its page does not cost it its turn.',
        config_file.unreal_return_seconds || '8'
    )
    .option(
        '--unreal_idle_timeout <seconds>',
        'A fresh Unreal that nobody has watched is kept for this long while nobody is waiting, then stopped.',
        config_file.unreal_idle_timeout || '600'
    )
    .option(
        '--max_session_seconds <seconds>',
        'Disconnects a viewer this long after it connected, as a backstop for the viewer page\'s own time limit. 0 = no limit.',
        config_file.max_session_seconds || '0'
    )
    .option(
        '--reverse-proxy',
        'Enables reverse proxy mode. This will trust the X-Forwarded-For header.',
        config_file.reverse_proxy || false
    )
    .addOption(
        new Option(
            '--reverse-proxy-num-proxies <number>',
            'Sets the number of proxies to trust. This is used to calculate the real client IP address.'
        )
            .implies({ reverse_proxy: true })
            .default(config_file.reverse_proxy_num_proxies || 1)
    )
    .option(
        '--log_config',
        'Will print the program configuration on startup.',
        config_file.log_config || false
    )
    .option('--stdin', 'Allows stdin input while running.', config_file.stdin || false)
    .option(
        '--save',
        'After arguments are parsed the config.json is saved with whatever arguments were specified at launch.',
        config_file.save || false
    )
    .helpOption('-h, --help', 'Display this help text.')
    .allowUnknownOption() // ignore unknown options which will allow versions to be swapped out into existing scripts with maybe older/newer options
    .parse();

// parsed command line options
const cli_options: IProgramOptions = program.opts();
const options: IProgramOptions = { ...cli_options };

// save out new configuration (unless disabled)
if (options.save) {
    // dont save certain options
    const save_options = { ...options };
    delete save_options.no_config;
    delete save_options.config_file;
    delete save_options.save;
    // The secret itself never goes to disk here; turn_secret_file is only a path, so it stays.
    delete save_options.turn_secret;

    // save out the config file with the current settings
    fs.writeFile(configArgsParser.config_file, beautify(save_options), (error: any) => {
        if (error) throw error;
    });
}

InitLogging({
    logDir: options.log_folder,
    logMessagesToConsole: options.console_messages,
    logLevelConsole: options.log_level_console,
    logLevelFile: options.log_level_file
});

// read the peer_options_file
if (options.peer_options_file) {
    if (!fs.existsSync(options.peer_options_file)) {
        Logger.error(`peer_options_file "${options.peer_options_file}" does not exist.`);
        throw Error(`Failed to find a peer options config file a file called ${options.peer_options_file}.`);
    }

    options.peer_options = JSON.parse(fs.readFileSync(options.peer_options_file, 'utf-8'));
} else if (options.peer_options) {
    Logger.warn(
        `The --peer_options cli flag has many issues with passing JSON data on the command line. It is recommended that you use --peer_options_file instead.`
    );
}

// read the turn_secret_file
if (options.turn_secret_file) {
    if (!fs.existsSync(options.turn_secret_file)) {
        Logger.error(`turn_secret_file "${options.turn_secret_file}" does not exist.`);
        throw Error(`Failed to find a turn secret file called ${options.turn_secret_file}.`);
    }

    // Trimmed because the usual way to write one of these is `echo $SECRET > secret.txt`, which
    // leaves a trailing newline that would silently produce credentials the TURN server rejects.
    options.turn_secret = fs.readFileSync(options.turn_secret_file, 'utf-8').trim();

    // An empty file would otherwise read as "no secret configured" and silently start the server
    // with the feature off, which looks identical to it working until a peer tries to relay.
    if (!options.turn_secret) {
        Logger.error(`turn_secret_file "${options.turn_secret_file}" is empty.`);
        throw Error(`The turn secret file ${options.turn_secret_file} contains no secret.`);
    }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
Logger.info(`${pjson.name} v${pjson.version} starting...`);
if (options.log_config) {
    Logger.info('Config:');
    for (const key in options) {
        // The config dump goes to the log file, which is kept and rotated - a secret written there
        // is a secret in every backup of this machine.
        const value: unknown = key === 'turn_secret' && options[key] ? '<redacted>' : options[key];
        Logger.info(`"${key}": ${JSON.stringify(value)}`);
    }
}

const app = express();
// commander stores --reverse-proxy as `reverseProxy` (camelCase), but this code read `reverse_proxy`, so the
// option never took effect and the proxy's X-Forwarded-For header was reported as a misconfiguration.
// Accept both spellings, so a value from config.json (snake_case) keeps working too.
const reverseProxy = options.reverseProxy ?? options.reverse_proxy;
const reverseProxyNumProxies = options.reverseProxyNumProxies ?? options.reverse_proxy_num_proxies;
if (reverseProxy) {
    app.set('trust proxy', reverseProxyNumProxies);
}

const serverOpts: IServerConfig = {
    streamerPort: options.streamer_port,
    streamerWsOptions: options.streamer_host ? { host: options.streamer_host } : undefined,
    playerPort: options.player_port,
    sfuPort: options.sfu_port,
    peerOptions: options.peer_options,
    maxSubscribers: options.max_players,
    playerKeepaliveTimeout: Number(options.player_keepalive_timeout)
};

// Time limited TURN credentials, when a shared secret was supplied. Without one the static username
// and credential in the peer options are sent to every peer exactly as before.
if (options.turn_secret) {
    const turnTtlSeconds = Number(options.turn_ttl);
    if (!Number.isFinite(turnTtlSeconds) || turnTtlSeconds <= 0) {
        Logger.error(`turn_ttl "${options.turn_ttl}" is not a positive number of seconds.`);
        throw Error(`Invalid turn_ttl "${options.turn_ttl}".`);
    }

    // `|| {}` because peer_options defaults to the empty string. SignallingServer normalises that
    // for the static path, but a provider's return value is sent as given - and a peer that receives
    // `""` as its configuration fails to construct its peer connection at all.
    serverOpts.peerOptionsProvider = createTurnCredentialsProvider(options.peer_options || {}, {
        secret: options.turn_secret,
        ttlSeconds: turnTtlSeconds
    });
    Logger.info(`Issuing time limited TURN credentials, valid for ${turnTtlSeconds} seconds.`);
} else if (hasCredentiallessTurnServer(options.peer_options)) {
    // Nothing is going to fill these in, and a peer that receives a TURN server it cannot
    // authenticate against fails later, at ICE, as a generic connection failure with nothing in
    // this log to connect it back to configuration.
    Logger.warn(
        'The peer options name a TURN server with no username or credential, and no --turn_secret ' +
            'was supplied to mint one. Peers will be unable to use that TURN server.'
    );
}

// ICE servers from a backend. The provider returns its cached copy; the cache is filled and kept
// fresh by a timer, so peers that connect before the first answer get the static options.
if (options.backend_ice_url) {
    if (options.turn_secret) {
        Logger.error('--backend_ice_url and --turn_secret both set the TURN credentials; use one of them.');
        throw Error('Use either --backend_ice_url or --turn_secret, not both.');
    }
    let backendKey: string = process.env.BACKEND_API_KEY || '';
    if (options.backend_ice_key_file) {
        if (!fs.existsSync(options.backend_ice_key_file)) {
            Logger.error(`backend_ice_key_file "${options.backend_ice_key_file}" does not exist.`);
            throw Error(`Failed to find a backend key file called ${options.backend_ice_key_file}.`);
        }
        backendKey = fs.readFileSync(options.backend_ice_key_file, 'utf-8').trim();
    }
    if (!backendKey) {
        Logger.error('--backend_ice_url needs an API key: --backend_ice_key_file or BACKEND_API_KEY.');
        throw Error('No API key for --backend_ice_url.');
    }
    const backendIceServers = new BackendIceServers({ url: options.backend_ice_url, apiKey: backendKey });
    serverOpts.peerOptionsProvider = backendIceServers.createProvider(options.peer_options);
    void backendIceServers.start();
    Logger.info(`Taking ICE servers from the backend at ${options.backend_ice_url}.`);
}

const shouldServerStart = options.serve || options.rest_api;
if (shouldServerStart) {
    const webserverOptions: IWebServerConfig = {
        httpPort: options.player_port,
        root: options.http_root,
        homepageFile: options.homepage,
        serveStatic: options.serve
    };

    if (options.cors) {
        const splitCsv = (value: unknown): string[] => {
            if (typeof value !== 'string' || value.length === 0) return [];
            return value
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
        };

        webserverOptions.cors = {
            enabled: true,
            allowedOrigins: splitCsv(options.cors_allowed_origins),
            allowedMethods: splitCsv(options.cors_allowed_methods),
            allowedHeaders: splitCsv(options.cors_allowed_headers),
            credentials: !!options.cors_credentials
        };
    }

    if (options.serve) {
        Logger.info('Static file serving enabled.');
    } else if (options.rest_api) {
        Logger.info('REST API enabled; static file serving disabled.');
    }

    if (options.https) {
        webserverOptions.httpsPort = options.https_port;
        const sslKeyPath = path.join(__dirname, '..', options.ssl_key_path);
        const sslCertPath = path.join(__dirname, '..', options.ssl_cert_path);
        if (fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath)) {
            Logger.info(`Reading SSL key and cert. Key path: ${sslKeyPath} | Cert path: ${sslCertPath}`);
            webserverOptions.ssl_key = fs.readFileSync(sslKeyPath);
            webserverOptions.ssl_cert = fs.readFileSync(sslCertPath);
        } else {
            Logger.warn(`No SSL key/cert found. Key path: ${sslKeyPath} | Cert path: ${sslCertPath}`);
        }
        webserverOptions.https_redirect = options.https_redirect;
    }
    const webServer = new WebServer(app, webserverOptions);
    if (!options.https || webserverOptions.https_redirect) {
        serverOpts.httpServer = webServer.httpServer;
    }
    serverOpts.httpsServer = webServer.httpsServer;
}

// Unreal on demand: a waiting line decides who may subscribe, the commands start and stop Unreal.
let onDemandUnreal: ReturnType<typeof createOnDemandUnreal> | undefined;
if (options.unreal_start_cmd || options.unreal_stop_cmd) {
    if (!options.unreal_start_cmd || !options.unreal_stop_cmd) {
        Logger.error('--unreal_start_cmd and --unreal_stop_cmd go together.');
        throw Error('Use --unreal_start_cmd and --unreal_stop_cmd together.');
    }
    onDemandUnreal = createOnDemandUnreal({
        startCommand: options.unreal_start_cmd,
        stopCommand: options.unreal_stop_cmd,
        startTimeoutSeconds: Number(options.unreal_start_timeout),
        minStartGapSeconds: Number(options.unreal_min_start_gap),
        turnTimeoutSeconds: Number(options.unreal_turn_timeout),
        idleStopSeconds: Number(options.unreal_idle_timeout),
        graceSeconds: Number(options.unreal_grace_seconds),
        returnSeconds: Number(options.unreal_return_seconds)
    });
    const controller = onDemandUnreal;
    serverOpts.canSubscribe = (playerId: string) => controller.canSubscribe(playerId);
    Logger.info('Unreal runs on demand: started for the first viewer, stopped when a viewer leaves.');
}

const signallingServer = new SignallingServer(serverOpts);
if (onDemandUnreal) {
    attachOnDemandUnreal(signallingServer, onDemandUnreal);
    // A waiting page asks for its place in line here (there is no streamer to subscribe to while Unreal restarts,
    // so the WebSocket alone cannot tell it). Read-only; it reveals how many are ahead of a viewer, nothing more.
    const controller = onDemandUnreal;
    app.get('/queue', (req: express.Request, res: express.Response) => {
        const key = typeof req.query.key === 'string' ? req.query.key.slice(0, 100) : '';
        res.set('Cache-Control', 'no-store');
        res.json(controller.status(key));
    });
}

const maxSessionSeconds = Number(options.max_session_seconds);
if (!Number.isFinite(maxSessionSeconds) || maxSessionSeconds < 0) {
    Logger.error(`max_session_seconds "${options.max_session_seconds}" is not a number of seconds.`);
    throw Error(`Invalid max_session_seconds "${options.max_session_seconds}".`);
}
if (maxSessionSeconds > 0) {
    limitSessionLength(signallingServer.playerRegistry, maxSessionSeconds);
    Logger.info(`Viewers are disconnected after ${maxSessionSeconds} seconds.`);
}

if (options.stdin) {
    initInputHandler(options, signallingServer);
}

if (options.rest_api) {
    initialize({
        app,
        docsPath: '/api-definition',
        exposeApiDocs: true,
        apiDoc: './apidoc/api-definition-base.yml',
        paths: [
            { path: '/config', module: configHandler },
            { path: '/players', module: playersHandler },
            { path: '/players/{playerId}', module: playerByIdHandler },
            { path: '/status', module: statusHandler },
            { path: '/streamers', module: streamersHandler },
            { path: '/streamers/{streamerId}', module: streamerByIdHandler }
        ],
        dependencies: {
            signallingServer
        }
    }).catch((err: unknown) => Logger.error(`REST API initialization failed: ${String(err)}`));
}
