// Minimal DataForSEO v3 client: basic auth, cost tracking, concurrency limit.

const BASE = 'https://api.dataforseo.com/v3';

class DataForSEOError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

class DataForSEO {
  constructor(login, password, { concurrency = 10 } = {}) {
    if (!login || !password) throw new Error('DataForSEO login and password are required');
    this.auth = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
    this.totalCost = 0;
    this.calls = 0;
  }

  async _slot() {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }

  _release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async request(method, path, body, attempt = 1) {
    await this._slot();
    let res, json;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120000),
      });
      json = await res.json().catch(() => null);
    } catch (err) {
      this._release();
      if (attempt < 3) {
        await sleep(1000 * attempt);
        return this.request(method, path, body, attempt + 1);
      }
      throw new DataForSEOError(`Network error calling DataForSEO: ${err.message}`);
    }
    this._release();

    if (!json) throw new DataForSEOError(`DataForSEO returned HTTP ${res.status} with no JSON body`);
    this.calls++;
    if (typeof json.cost === 'number') this.totalCost += json.cost;

    // 40100 = auth failed, 40200 = out of funds, 40202 = rate limit
    if (json.status_code === 40202 && attempt < 4) {
      await sleep(3000 * attempt);
      return this.request(method, path, body, attempt + 1);
    }
    if (json.status_code !== 20000) {
      throw new DataForSEOError(`DataForSEO: ${json.status_message} (${json.status_code})`, json.status_code);
    }
    return json;
  }

  // Posts a single task and returns that task's first result object (or null).
  async live(path, task) {
    const json = await this.request('POST', path, [task]);
    const t = json.tasks && json.tasks[0];
    if (!t) return null;
    if (t.status_code !== 20000) {
      // 40102 = "No Search Results" — a normal outcome, not an error.
      if (t.status_code === 40102) return { items: [] };
      throw new DataForSEOError(`DataForSEO task: ${t.status_message} (${t.status_code})`, t.status_code);
    }
    return (t.result && t.result[0]) || { items: [] };
  }

  async mapsLive(task) {
    return this.live('/serp/google/maps/live/advanced', task);
  }

  async organicLive(task) {
    return this.live('/serp/google/organic/live/advanced', task);
  }

  async domainRankOverview(task) {
    return this.live('/dataforseo_labs/google/domain_rank_overview/live', task);
  }

  async rankedKeywords(task) {
    return this.live('/dataforseo_labs/google/ranked_keywords/live', task);
  }

  // Ads Transparency search has no live endpoint: post, then poll task_get.
  async adsSearch(task, { timeoutMs = 120000, pollMs = 5000 } = {}) {
    const posted = await this.request('POST', '/serp/google/ads_search/task_post', [task]);
    const t = posted.tasks && posted.tasks[0];
    if (!t || !(t.status_code === 20100 || t.status_code === 20000)) {
      throw new DataForSEOError(`Ads search task not accepted: ${t ? t.status_message : 'no task'}`);
    }
    const id = t.id;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const got = await this.request('GET', `/serp/google/ads_search/task_get/advanced/${id}`);
      const gt = got.tasks && got.tasks[0];
      if (!gt) continue;
      if (gt.status_code === 20000) return (gt.result && gt.result[0]) || { items: [] };
      if (gt.status_code === 40102) return { items: [] };
      // 40601 / 40602 = task still in queue / in progress
      if (gt.status_code !== 40601 && gt.status_code !== 40602) {
        throw new DataForSEOError(`Ads search: ${gt.status_message} (${gt.status_code})`, gt.status_code);
      }
    }
    throw new DataForSEOError('Ads Transparency lookup timed out');
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { DataForSEO, DataForSEOError };
