import { SafarSaathiClient } from '../client.js';

export abstract class BaseRepository {
  protected client: SafarSaathiClient;

  constructor(client: SafarSaathiClient) {
    this.client = client;
  }
}
