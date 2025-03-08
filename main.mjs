import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import winston from 'winston';
import 'winston-daily-rotate-file';
import { SourceQuerySocket } from 'source-server-query';
import axios from 'axios';
import { EventEmitter } from 'events';
import fs from 'fs';

// Load environment variables from .env file
dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID_1 = process.env.CHANNEL_ID_1;
const CHANNEL_ID_2 = process.env.CHANNEL_ID_2;
const STEAM_API_KEY = process.env.STEAM_API_KEY;
const GAME_ID = 686810;

// Adjust these as needed
const QUERY_TIMEOUT = 100;     // ms to wait before timing out a single server query
const QUERY_DELAY = 50;       // ms delay between sequential server queries
const MAX_RETRIES = 1;         // how many times to retry a failed query
const UPDATE_INTERVAL = 15000; // how often updateServers() runs

// Set up logging with rotating file handler
const logFormatter = winston.format.printf(({ timestamp, level, message }) => `${timestamp}:${level}:${message}`);
const logTransports = [
    new winston.transports.Console(),
    new winston.transports.DailyRotateFile({
        filename: 'hll-observer-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '10m',
        maxFiles: '2',
    }),
];
const logger = winston.createLogger({
    format: winston.format.combine(
        winston.format.timestamp(),
        logFormatter
    ),
    transports: logTransports,
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
});

// Keep track of which messages we have sent to each channel
let lastMessages = { [CHANNEL_ID_1]: [], [CHANNEL_ID_2]: [] };

// This will handle queries to Source-engine servers
const query = new SourceQuerySocket();

// Increase max listeners if you run into warnings about event emitter leaks
EventEmitter.prototype.setMaxListeners(30);

// Simple delay function
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch and filter servers
 * - First, try to load from servers.json if it exists in the running directory
 * - If not, fetch from Steam Web API and apply filters
 */
const fetchAndFilterServers = async () => {
    const serversFilePath = 'servers.json';
    if (fs.existsSync(serversFilePath)) {
        try {
            const data = fs.readFileSync(serversFilePath, 'utf8');
            const servers = JSON.parse(data);
            logger.info(`Loaded ${servers.length} servers from servers.json`);
            return servers;
        } catch (error) {
            logger.error(`Error reading or parsing servers.json: ${error.message}`);
            logger.info('Falling back to fetching server list from Steam');
        }
    } else {
        logger.info('servers.json not found, fetching server list from Steam');
    }

    // Fetch from Steam if servers.json is not available or failed to load
    try {
        const response = await axios.get('https://api.steampowered.com/IGameServersService/GetServerList/v1/', {
            params: {
                key: STEAM_API_KEY,
                filter: `\\appid\\${GAME_ID}`,
            }
        });

        const servers = response.data.response.servers;

        // Filter for German servers, excluding certain keywords
        const germanServers = servers.filter(server =>
            /GER|GERMAN|DEUTSCH/.test(server.name.toUpperCase()) &&
            !/EVENT/i.test(server.name) &&
            !/JAGER/i.test(server.name) &&
            !/BADGERGROUNDS/i.test(server.name) &&
            !/SWE/i.test(server.name)
        );

        // Convert to { address, port } format
        const filteredServers = germanServers.map(server => ({
            address: server.addr.split(':')[0],
            port: parseInt(server.addr.split(':')[1], 10),
        }));

        logger.info(`Fetched ${filteredServers.length} servers from Steam`);
        return filteredServers;
    } catch (error) {
        logger.error(`Error fetching server list from Steam: ${error.message}`);
        return []; // Return empty array if both servers.json and Steam fetch fail
    }
};

/**
 * Cache object to store last known good data
 * - key: "address:port"
 * - value: { serverInfo, playerList }
 */
let lastSuccessfulQueryResults = {};

// Helper to format time from seconds
const formatDuration = (seconds) => {
    if (isNaN(seconds) || seconds < 0) {
        return '0:00';
    }
    const totalMinutes = Math.floor(seconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}:${minutes.toString().padStart(2, '0')}`;
};

/**
 * Query server for player list
 * - Retries up to MAX_RETRIES times
 * - Falls back to cached data if all attempts fail
 */
const getPlayerList = async (address, port, retries = MAX_RETRIES) => {
    try {
        const playerList = await query.players(address, port, QUERY_TIMEOUT);
        logger.info(`Player List for ${address}:${port}`, playerList);
        return playerList || [];
    } catch (error) {
        logger.error(`Error querying players for ${address}:${port}`, error);

        if (retries > 0) {
            logger.info(`Retrying player query for ${address}:${port} (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
            await delay(QUERY_DELAY);
            return getPlayerList(address, port, retries - 1);
        } else {
            const serverKey = `${address}:${port}`;
            if (lastSuccessfulQueryResults[serverKey]?.playerList) {
                logger.info(`Using cached playerList for ${serverKey}`);
                return lastSuccessfulQueryResults[serverKey].playerList;
            }
            return [];
        }
    }
};

/**
 * Query server for basic info
 * - Falls back to cached data if query fails
 */
const getServerInfo = async (address, port) => {
    const serverKey = `${address}:${port}`;
    try {
        const serverInfo = await query.info(address, port, QUERY_TIMEOUT);
        logger.info(`Server Info for ${address}:${port}`, serverInfo);
        return serverInfo || {};
    } catch (error) {
        logger.error(`Error querying server info for ${address}:${port}`, error);
        if (lastSuccessfulQueryResults[serverKey]?.serverInfo) {
            logger.info(`Using cached serverInfo for ${serverKey}`);
            return lastSuccessfulQueryResults[serverKey].serverInfo;
        }
        return {};
    }
};

/**
 * Clear existing channel messages
 */
const clearChannel = async (channel) => {
    try {
        const fetchedMessages = await channel.messages.fetch({ limit: 100 });
        const deletionPromises = fetchedMessages.map(message => message.delete());
        await Promise.all(deletionPromises);
        logger.info(`Deleted ${fetchedMessages.size} message(s) in the channel.`);
    } catch (error) {
        logger.error(`Error while trying to delete messages: ${error.message}`);
    }
};

/**
 * Format players into a single string
 * - If more than 40 players, hide the list to avoid clutter
 */
const formatPlayerListEmbed = (players) => {
    if (players.length > 40) {
        return 'Mehr als 40 Spieler - Liste deaktiviert.';
    }

    return players
        .filter(player => player.name && player.name.trim() !== '')
        .map(player => {
            const playerName = player.name || 'Unknown';
            const playerTime = formatDuration(player.duration || 0);
            return `${playerName} (${playerTime})`;
        })
        .join('\n');
};

/**
 * Build embeds for Discord
 */
const createEmbedsForServer = (server) => {
    const playerList = formatPlayerListEmbed(server.playerList);

    const embed = new EmbedBuilder()
        .setTitle(`${server.name}`)
        .setDescription(`Spieler: ${server.players}/${server.maxPlayers}\n\n${playerList}`);

    return [embed];
};

// Global list of servers loaded from servers.json or fetched from Steam
let servers = [];

/**
 * Initial fetch of server list
 */
const updateServerList = async () => {
    servers = await fetchAndFilterServers();
};

/**
 * Main loop: update servers
 * - Grabs info for each server
 * - If query fails, uses cached data
 * - Posts or updates messages in Discord
 */
let isUpdating = false;

const updateServers = async () => {
    if (isUpdating) {
        logger.info('Update already in progress, skipping this cycle');
        return;
    }
    isUpdating = true;

    try {
        const serverDetails = await Promise.all(servers.map(async (server) => {
            await delay(QUERY_DELAY);

            const serverKey = `${server.address}:${server.port}`;
            let serverInfo;
            let playerList;

            try {
                serverInfo = await getServerInfo(server.address, server.port);
                playerList = await getPlayerList(server.address, server.port);
                lastSuccessfulQueryResults[serverKey] = { serverInfo, playerList };
            } catch (error) {
                logger.error(`Error querying server ${serverKey}: ${error.message}`);
                if (lastSuccessfulQueryResults[serverKey]) {
                    serverInfo = lastSuccessfulQueryResults[serverKey].serverInfo;
                    playerList = lastSuccessfulQueryResults[serverKey].playerList;
                    logger.info(`Using cached results for ${serverKey}`);
                } else {
                    serverInfo = {};
                    playerList = [];
                }
            }

            return {
                ...server,
                players: serverInfo.players || 0,
                maxPlayers: serverInfo.maxPlayers || 100,
                name: serverInfo.name
                    ? serverInfo.name.replace(/\s+/g, ' ').trim().replace(/\./g, '.\u200B')
                    : 'Unknown Server',
                playerList
            };
        }));

        const sortedServers = serverDetails
            .filter(server => server.players > 0 && server.players <= 40)
            .sort((a, b) => b.players - a.players);

        const embedsToSend = [];
        const seenServerNames = new Set();

        for (const server of sortedServers) {
            const serverName = server.name.replace(/Clan!Twitch/g, 'Clan');
            if (!seenServerNames.has(serverName)) {
                seenServerNames.add(serverName);
                server.name = serverName;
                const serverEmbeds = createEmbedsForServer(server);
                embedsToSend.push(...serverEmbeds);
            } else {
                logger.warn(`Duplicate server name detected: ${serverName}`);
            }
        }

        for (const channelId of [CHANNEL_ID_1, CHANNEL_ID_2]) {
            try {
                const channel = await client.channels.fetch(channelId);
                if (channel) {
                    const previousMessages = lastMessages[channelId] || [];
                    const newMessages = [];

                    for (let i = 0; i < embedsToSend.length; i++) {
                        const embed = embedsToSend[i];
                        if (i < previousMessages.length) {
                            try {
                                const msg = await channel.messages.fetch(previousMessages[i]);
                                await msg.edit({ embeds: [embed] });
                                newMessages.push(previousMessages[i]);
                            } catch (error) {
                                logger.error(`Error editing message: ${error.message}`);
                                const msg = await channel.send({ embeds: [embed] });
                                newMessages.push(msg.id);
                            }
                        } else {
                            const msg = await channel.send({ embeds: [embed] });
                            newMessages.push(msg.id);
                        }
                    }

                    for (let i = embedsToSend.length; i < previousMessages.length; i++) {
                        try {
                            const msg = await channel.messages.fetch(previousMessages[i]);
                            await msg.delete();
                        } catch (error) {
                            logger.error(`Error deleting message: ${error.message}`);
                        }
                    }

                    lastMessages[channelId] = newMessages;
                }
            } catch (error) {
                logger.error(`Error fetching channel or processing messages: ${error.message}`);
            }
        }
    } catch (error) {
        logger.error(`Error in updateServers: ${error.message}`);
    } finally {
        isUpdating = false;
    }
};

/**
 * Start bot
 */
client.once('ready', async () => {
    logger.info(`${client.user.tag} has connected to Discord!`);
    const channels = [CHANNEL_ID_1, CHANNEL_ID_2];
    for (const channelId of channels) {
        try {
            const channel = await client.channels.fetch(channelId);
            if (channel) {
                await clearChannel(channel);
            }
        } catch (error) {
            logger.error(`Error clearing channel: ${error.message}`);
        }
    }

    await updateServerList();
    setInterval(updateServers, UPDATE_INTERVAL);
});

client.login(TOKEN);
