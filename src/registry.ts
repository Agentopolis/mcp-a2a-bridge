import { promises as fs } from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { randomUUID } from 'node:crypto';

// Helper to create a filesystem-friendly slug
function slugify(text: string): string {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')           // Replace spaces with -
    .replace(/[^\w-]+/g, '')       // Remove all non-word chars (keeps alphanumerics and hyphens)
    .replace(/--+/g, '-')         // Replace multiple - with single -
    .replace(/^-+/, '')             // Trim - from start of text
    .replace(/-+$/, '');            // Trim - from end of text
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

  private filePath(id: string) {
    return path.join(this.dir, `${id}.json`);
  }

  private async _readServerFile(filePath: string): Promise<RegisteredServer | undefined> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const server = JSON.parse(raw) as RegisteredServer;
      // Optional: Add validation here if needed (e.g., check for essential fields)
      return server;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[A2ARegistry] Failed to read or parse server file ${filePath}:`, err);
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
        if (server?.id) { // Ensure server and its ID are valid
            this.cache.set(slugify(server.id), server);
        }
      }
      console.error(`[A2ARegistry] Reloaded servers. Found ${this.cache.size} valid configurations in ${this.dir}.`);
      return { count: this.cache.size };
    } catch (err) {
      console.error(`[A2ARegistry] Failed to reload servers from directory ${this.dir}:`, err);
      return { count: 0 }; // Return 0 if directory read fails
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
      if (!resp.ok) {
        throw new Error(`Failed to fetch agent card from ${cardEndpoint}: HTTP ${resp.status}`);
      }
      card = (await resp.json()) as AgentCard;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[A2ARegistry] Error fetching/parsing agent card from ${cardEndpoint}: ${message}`);
      throw new Error(`Could not retrieve/parse agent card. Details: ${message}`);
    }
    

    // Validate required fields from the card as per a2a.json
    const requiredFields: (keyof AgentCard)[] = ['name', 'url', 'version', 'capabilities', 'skills'];
    for (const field of requiredFields) {
      if (card[field] === undefined || card[field] === null || (typeof card[field] === 'string' && (card[field] as string).trim() === '')) {
        throw new Error(`Agent card from ${cardEndpoint} is missing/invalid required field: "${String(field)}"`);
      }
    }
    if (!Array.isArray(card.skills)) {
         throw new Error(`Agent card from ${cardEndpoint} has an invalid "skills" field: not an array.`);
    }


    // Determine the ID for this registration
    let registrationId: string;
    if (card.id && typeof card.id === 'string' && card.id.trim().length > 0) {
      registrationId = slugify(card.id); // Slugify even if provided, for consistency
    } else if (card.name && typeof card.name === 'string' && card.name.trim().length > 0) {
      const sluggedName = slugify(card.name);
      if (sluggedName.length > 0) {
        registrationId = sluggedName;
      } else {
        registrationId = randomUUID(); // Fallback if name slugs to empty
      }
    } else {
      registrationId = randomUUID(); // Fallback if no id and no name
    }
    
    if (!registrationId) { // Should not happen with UUID fallback, but as a safeguard
        console.warn(`[A2ARegistry] Could not determine a valid registration ID for card from ${cardEndpoint}, falling back to UUID.`);
        registrationId = randomUUID();
    }


    const existingFromCache = this.cache.get(registrationId);
    if (existingFromCache && existingFromCache.registrationUrl === registrationUrl && existingFromCache.card.url === card.url) {
        console.error(`[A2ARegistry] Server with derived ID "${registrationId}" (URL: ${registrationUrl}, Card URL: ${card.url}) already registered and cached. Returning existing.`);
        return existingFromCache;
    }
    // Fallback: Check disk if not in cache or if details differ (edge case, cache should be source of truth after init/reload)
    const existingFromDisk = await this._readServerFile(this.filePath(registrationId));
    if (existingFromDisk && existingFromDisk.registrationUrl === registrationUrl && existingFromDisk.card.url === card.url) {
      this.cache.set(registrationId, existingFromDisk); // Ensure cache consistency
      console.error(`[A2ARegistry] Server with derived ID "${registrationId}" (URL: ${registrationUrl}) found on disk and matched. Returning existing.`);
      return existingFromDisk;
    }

    const entry: RegisteredServer = {
      id: registrationId,
      registrationUrl,
      card,
      addedAt: new Date().toISOString(),
    };

    await fs.writeFile(this.filePath(registrationId), JSON.stringify(entry, null, 2), 'utf-8');
    this.cache.set(registrationId, entry); // Add to cache
    console.error(`[A2ARegistry] Registered new server: ID "${registrationId}", Name: "${card.name}", SourceURL: ${registrationUrl}. Cached.`);
    return entry;
  }

  /** Retrieve a server by its derived registration id */
  async get(id: string): Promise<RegisteredServer | undefined> {
    const sluggedId = slugify(id);
    if (this.cache.has(sluggedId)) {
      return this.cache.get(sluggedId);
    }
    // Fallback: try to load from disk if not in cache (e.g., if file added manually after init/reload)
    const serverFromFile = await this._readServerFile(this.filePath(sluggedId));
    if (serverFromFile) {
      this.cache.set(sluggedId, serverFromFile); // Add to cache if found on disk
      return serverFromFile;
    }
    return undefined;
  }

  /** List all registered servers */
  async list(): Promise<RegisteredServer[]> {
    // Primarily return from cache for consistency and performance
    // If a truly fresh list from disk is always needed, this could read disk directly.
    return Array.from(this.cache.values());
  }

  async remove(id: string): Promise<boolean> {
    const sluggedId = slugify(id);
    const filePath = this.filePath(sluggedId);
    try {
      // Check if it exists in cache or on disk before attempting to delete
      const existsInCache = this.cache.has(sluggedId);
      let existsOnDisk = false;
      try {
        await fs.access(filePath); // Check if file exists and is accessible
        existsOnDisk = true;
      } catch {
        // File does not exist or is not accessible
        existsOnDisk = false;
      }

      if (!existsInCache && !existsOnDisk) {
        console.error(`[A2ARegistry] Attempted to remove server ID "${sluggedId}", but it was not found.`);
        return false; // Not found
      }

      if (existsOnDisk) {
        await fs.unlink(filePath); // Delete the file
      }
      
      const removedFromCache = this.cache.delete(sluggedId); // Remove from cache

      if (existsOnDisk) {
        console.error(`[A2ARegistry] Successfully removed server ID "${sluggedId}" from disk and cache.`);
      } else if (removedFromCache) {
         console.error(`[A2ARegistry] Successfully removed server ID "${sluggedId}" from cache (was not on disk).`);
      } 
      // If neither, it means it wasn't found (handled by the first check)

      return true; // Successfully removed or was already not present in one of the locations but action taken
    } catch (err) {
      console.error(`[A2ARegistry] Error removing server ID "${sluggedId}":`, err);
      return false; // Indicate failure
    }
  }
} 