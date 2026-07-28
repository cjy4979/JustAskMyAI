import os from "node:os";
import { Bonjour } from "bonjour-service";

interface DiscoveredService {
  fqdn: string;
  name: string;
  port: number;
  txt?: Record<string, unknown>;
  addresses?: string[];
}

interface DiscoveryBrowser {
  on(event: "up", listener: (service: DiscoveredService) => void): void;
  stop(): void;
}

export interface Peer {
  id: string;
  name: string;
  url: string;
  source: "lan" | "manual" | "hub";
  lastSeenAt: string;
}

export class PeerRegistry {
  private readonly peers = new Map<string, Peer>();

  upsert(peer: Peer): void {
    this.peers.set(peer.id, peer);
  }

  list(): Peer[] {
    return [...this.peers.values()];
  }

  get(id: string): Peer | undefined {
    return this.peers.get(id);
  }
}

export class LanDiscovery {
  private readonly bonjour = new Bonjour();
  private browser?: DiscoveryBrowser;

  constructor(
    private readonly node: { id: string; name: string; port: number },
    private readonly registry: PeerRegistry,
  ) {}

  start(): void {
    this.bonjour.publish({
      name: this.node.name,
      type: "justaskmyai",
      protocol: "tcp",
      port: this.node.port,
      txt: { id: this.node.id, path: "/" },
    });
    this.browser = this.bonjour.find({
      type: "justaskmyai",
      protocol: "tcp",
    }) as unknown as DiscoveryBrowser;
    this.browser.on("up", (service) => {
      const id = String(service.txt?.id ?? service.fqdn);
      if (id === this.node.id) return;
      const address = preferredAddress(service);
      if (!address) return;
      this.registry.upsert({
        id,
        name: service.name,
        url: `http://${formatHost(address)}:${service.port}`,
        source: "lan",
        lastSeenAt: new Date().toISOString(),
      });
    });
  }

  stop(): void {
    this.browser?.stop();
    this.bonjour.unpublishAll();
    this.bonjour.destroy();
  }
}

function preferredAddress(service: DiscoveredService): string | undefined {
  return service.addresses?.find((value) => value.includes("."))
    ?? service.addresses?.[0]
    ?? os.hostname();
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
