import { promises as fs } from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { randomUUID } from 'node:crypto';

// Helper to create a filesystem-friendly slug
export function slugify(text: string, maxLength?: number): string {
  if (!text) return '';
  let slug = text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')           // Replace spaces with -
    .replace(/[^\w-]+/g, '')       // Remove all non-word chars (keeps alphanumerics and hyphens)
    .replace(/--+/g, '-')         // Replace multiple - with single -
    .replace(/^-+/, '')             // Trim - from start of text
    .replace(/-+$/, '');            // Trim - from end of text

  if (maxLength && slug.length > maxLength) {
    slug = slug.substring(0, maxLength);
    slug = slug.replace(/-+$/, ''); // Remove trailing hyphen if cut off
  }
  return slug;
}

// Shape of an A2A agent card based on a2a.json schema
export interface AgentCard {
  id?: string; // Optional, as per schema
  name: string; // Required
  url: string; // Required (base URL of the agent itself)
  version: string; // Required
  description?: string;
  capabilities: unknown; // Required (actual type AgentCapabilities)
  skills: unknown[]; // Required (actual type AgentSkill[])
  // Allow other fields as per schema's flexibility
  [key: string]: unknown;
}

export interface RegisteredServer {
  id: string; // Unique identifier for this registration (derived if not in card.id)
  registrationUrl: string; // The URL used to register this server (the one with /.well-known)
  card: AgentCard;
  addedAt: string; // ISO timestamp
}

const MAX_SERVER_ID_SLUG_LENGTH = 20;

/**
 * Persists A2A server registrations on the local filesystem.
 * Each server is stored as a separate JSON file: <dir>/<registrationId>.json
 */
export class A2ARegistry {
  private cache: Map<string, RegisteredServer> = new Map();

  constructor(private readonly dir: string) {}

  /** Ensure the directory exists */
  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    await this.reloadServers(); // Load all servers into cache on init
    console.error(`[A2ARegistry] Initialized. Loaded ${this.cache.size} servers from ${this.dir} into cache.`);
  }

  private filePath(sluggedId: string) {
    return path.join(this.dir, `${sluggedId}.json`);
  }

  private async _readServerFile(filePath: string): Promise<RegisteredServer | undefined> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as RegisteredServer;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[A2ARegistry] Failed to read/parse ${filePath}:`, err);
      }
      return undefined;
    }
  }

  async reloadServers(): Promise<{ count: number }> {
    this.cache.clear();
    try {
      const files = await fs.readdir(this.dir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const server = await this._readServerFile(path.join(this.dir, f));
        if (server?.id) {
            // The ID stored in the RegisteredServer object is the one we use for the cache key.
            // This ID should already be the shortened, final version.
            this.cache.set(server.id, server);
        } else {
            console.warn(`[A2ARegistry] Server file ${f} missing valid ID, skipping.`);
        }
      }
      console.error(`[A2ARegistry] Reloaded. Found ${this.cache.size} valid configurations.`);
      return { count: this.cache.size };
    } catch (err) {
      console.error(`[A2ARegistry] Failed to reload servers from ${this.dir}:`, err);
      return { count: 0 };
    }
  }

  /**
   * Register a new A2A server by URL. Fetches its agent card to obtain details.
   * If already registered (based on the derived ID from card content), returns the existing record.
   */
  async register(registrationUrl: string): Promise<RegisteredServer> {
    const baseForResolution = registrationUrl.endsWith('/') ? registrationUrl : `${registrationUrl}/`;
    const cardEndpoint = new URL('.well-known/agent.json', baseForResolution).toString();
    let card: AgentCard;
    try {
      const resp = await fetch(cardEndpoint);
      if (!resp.ok) throw new Error(`Fetch card ${cardEndpoint} failed: ${resp.status}`);
      card = (await resp.json()) as AgentCard;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[A2ARegistry] Fetch/parse card from ${cardEndpoint} error: ${msg}`);
      throw new Error(`Could not retrieve/parse agent card. Details: ${msg}`);
    }
    
    const requiredFields: (keyof AgentCard)[] = ['name', 'url', 'version', 'capabilities', 'skills'];
    for (const field of requiredFields) {
      if (!card[field] || (typeof card[field] === 'string' && !(card[field] as string).trim())) {
        throw new Error(`Agent card from ${cardEndpoint} missing/invalid required field: "${String(field)}"`);
      }
    }
    if (!Array.isArray(card.skills)) {
         throw new Error(`Agent card from ${cardEndpoint} invalid "skills": not an array.`);
    }

    let registrationId: string;

    // Check if card.id is a usable, non-empty string
    if (card.id && typeof card.id === 'string' && card.id.trim()) {
      const trimmedCardId = card.id.trim(); // Use the trimmed version for slugify
      const sluggedCardId = slugify(trimmedCardId, MAX_SERVER_ID_SLUG_LENGTH);

      if (sluggedCardId) { // Successfully slugified to a non-empty string
        registrationId = sluggedCardId;
        // Using console.log for informational message about successful ID use
        console.error(`[A2ARegistry] Using card.id "${trimmedCardId}" (slugged to "${registrationId}") for server from ${cardEndpoint}.`);
      } else {
        // card.id was a non-empty string, but slugified to an empty string (e.g., contained only symbols)
        console.error(`[A2ARegistry] Card ID "${trimmedCardId}" from ${cardEndpoint} slugified to an empty string. Generating a UUID-based ID instead.`);
        registrationId = randomUUID().substring(0, MAX_SERVER_ID_SLUG_LENGTH);
      }
    } else {
      // card.id is missing, not a string, or an empty string (or only whitespace).
      // Fallback to a UUID-based ID. Do not use card.name.
      if (card.id !== undefined && card.id !== null) {
        // card.id was provided but was invalid (e.g., empty string, non-string type)
        console.error(`[A2ARegistry] Invalid or empty card.id ("${card.id}") provided for server from ${cardEndpoint}. Generating a UUID-based ID.`);
      } else {
        // card.id was not provided at all (undefined or null)
        console.error(`[A2ARegistry] Card ID not provided for server from ${cardEndpoint}. Generating a UUID-based ID.`);
      }
      registrationId = randomUUID().substring(0, MAX_SERVER_ID_SLUG_LENGTH);
    }
    // The previous fallback `if (!registrationId) { ... }` is removed as registrationId should always be set now.

    const existingFromCache = this.cache.get(registrationId);
    if (existingFromCache?.registrationUrl === registrationUrl && existingFromCache?.card.url === card.url) {
        console.error(`[A2ARegistry] Server ID "${registrationId}" (URL: ${registrationUrl}) already cached. Returning existing.`);
        return existingFromCache;
    }
    const diskEntry = await this._readServerFile(this.filePath(registrationId));
    if (diskEntry?.registrationUrl === registrationUrl && diskEntry?.card.url === card.url) {
      this.cache.set(registrationId, diskEntry); // Ensure cache consistency
      console.error(`[A2ARegistry] Server ID "${registrationId}" (URL: ${registrationUrl}) on disk matched. Returning existing.`);
      return diskEntry;
    }

    const entry: RegisteredServer = {
      id: registrationId, 
      registrationUrl,
      card,
      addedAt: new Date().toISOString(),
    };

    await fs.writeFile(this.filePath(registrationId), JSON.stringify(entry, null, 2), 'utf-8');
    this.cache.set(registrationId, entry);
    console.error(`[A2ARegistry] Registered new server: ID "${registrationId}", Name: "${card.name}".`);
    return entry;
  }

  /** Retrieve a server by its derived registration id */
  async get(id: string): Promise<RegisteredServer | undefined> {
    const sluggedIdToSearch = slugify(id, MAX_SERVER_ID_SLUG_LENGTH);
    if (this.cache.has(sluggedIdToSearch)) {
      return this.cache.get(sluggedIdToSearch);
    }
    const serverFromFile = await this._readServerFile(this.filePath(sluggedIdToSearch));
    if (!serverFromFile) return undefined; // File not found or unreadable

    // The ID in the file *is the canonical, already shortened ID*. Match against that.
    if (serverFromFile.id === sluggedIdToSearch) {
        this.cache.set(sluggedIdToSearch, serverFromFile);
        return serverFromFile;
    }
    // This case implies the filename (sluggedIdToSearch) doesn't match the ID stored inside the file.
    // This could happen if a file was manually renamed or its content ID changed.
    // For consistency, we prioritize the filename as the key if it exists.
    // However, our registration process ensures filename matches internal ID.
    // If they don't match, it suggests external tampering or a bug.
    console.error(`[A2ARegistry] File found for key '${sluggedIdToSearch}', but its internal ID '${serverFromFile.id}' differs. Returning based on filename key if content is valid.`);
    // As a safety, we could re-validate serverFromFile.id here if needed.
    // For now, if file exists at path derived from sluggedIdToSearch, and it's a valid RegisteredServer, return it.
    this.cache.set(sluggedIdToSearch, serverFromFile); // Cache it under the filename-derived key
    return serverFromFile; 
  }

  /** List all registered servers */
  async list(): Promise<RegisteredServer[]> {
    // Primarily return from cache for consistency and performance
    // If a truly fresh list from disk is always needed, this could read disk directly.
    return Array.from(this.cache.values());
  }

  async remove(id: string): Promise<boolean> {
    const sluggedIdToRemove = slugify(id, MAX_SERVER_ID_SLUG_LENGTH);
    const filePath = this.filePath(sluggedIdToRemove);
    try {
      const existsInCache = this.cache.has(sluggedIdToRemove);
      let existsOnDisk = false;
      try { await fs.access(filePath); existsOnDisk = true; } catch { /* ignore */ }

      if (!existsInCache && !existsOnDisk) {
        console.error(`[A2ARegistry] Remove failed: Server ID "${sluggedIdToRemove}" not found.`);
        return false;
      }
      if (existsOnDisk) await fs.unlink(filePath);
      this.cache.delete(sluggedIdToRemove);
      console.error(`[A2ARegistry] Removed server ID "${sluggedIdToRemove}".`);
      return true;
    } catch (err) {
      console.error(`[A2ARegistry] Error removing "${sluggedIdToRemove}":`, err);
      return false;
    }
  }
} 