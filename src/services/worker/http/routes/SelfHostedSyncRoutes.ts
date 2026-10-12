import express, { type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { logger } from '../../../../utils/logger.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import { getWorkerHost } from '../../../../shared/worker-utils.js';
import type { Baseline } from '../../../sync/self-hosted/SelfHostedSync.js';

/** SSH accesses loopback only. Never accept browser origins, forwarded-IP trust,
 * public binds, or unauthenticated remote writes. Disabled until explicit setup.
 */
export class SelfHostedSyncRoutes {
  constructor(private manager: DatabaseManager, private options: { allowSetup?: boolean; host?: () => string } = {}) {}
  setupRoutes(app: express.Application): void {
    const router = express.Router();
    router.use((req: Request, res: Response, next: NextFunction) => {
      const host = (this.options.host ?? getWorkerHost)();
      const remote = req.socket.remoteAddress;
      if (!['127.0.0.1', '::1', 'localhost'].includes(host) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '') || req.headers.origin || req.headers['sec-fetch-site']) {
        logger.warn('SECURITY', 'Private sync access rejected: loopback CLI access required');
        res.status(403).json({ error: 'self-hosted sync requires a loopback worker and non-browser SSH/CLI access' }); return;
      }
      if (req.path === '/setup' && (this.options.allowSetup ?? process.env.CLAUDE_MEM_SELF_HOSTED_SYNC_ALLOW_SETUP === '1')) { next(); return; }
      const token = this.manager.getSelfHostedSync().token();
      const presented = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') ?? '')?.[1] ?? '';
      if (!token || Buffer.byteLength(presented) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(presented), Buffer.from(token))) {
        logger.debug('SECURITY', 'Private sync authentication rejected');
        res.status(401).json({ error: 'self-hosted sync token required' });
        return;
      }
      next();
    });
    const handle = (handler: (req: Request, res: Response) => void | Promise<void>) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve().then(() => handler(req, res)).catch(next); };
    router.get('/status', handle((_req, res) => { res.json(this.manager.getSelfHostedSync().status()); }));
    router.get('/baseline', handle((_req, res) => { res.json(this.manager.getSelfHostedSync().baseline()); }));
    router.post('/reconcile', handle((req, res) => { res.json(this.manager.getSelfHostedSync().reconcile(req.body as Baseline)); }));
    router.post('/setup', handle((req, res) => {
      if (this.manager.getCloudSync()) throw new Error('disable Pro sync before self-hosted setup');
      const body = z.object({ independent: z.boolean().optional(), baseline: z.unknown().optional() }).strict().parse(req.body);
      res.json(this.manager.getSelfHostedSync().setup({ independent: body.independent, baseline: body.baseline as Baseline | undefined }));
    }));
    router.post('/enabled', handle((req, res) => { const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body); if (enabled && this.manager.getCloudSync()) throw new Error('disable Pro sync before enabling the private journal'); this.manager.getSelfHostedSync().setEnabled(enabled); res.json({ enabled }); }));
    router.post('/prepare', handle((req, res) => { const { peer } = z.object({ peer: z.string().uuid().optional() }).strict().parse(req.body); res.json(this.manager.getSelfHostedSync().prepare(peer)); }));
    router.post('/exchange', handle((req, res) => { const sync = this.manager.getSelfHostedSync(); res.json(sync.exchange(req.body)); void sync.flushIndexJobs().catch(() => {}); }));
    router.post('/accept', handle((req, res) => { const { request, response } = z.object({ request: z.unknown(), response: z.unknown() }).strict().parse(req.body); const sync = this.manager.getSelfHostedSync(); sync.accept(response, request as Parameters<typeof sync.accept>[1]); res.json(sync.status()); void sync.flushIndexJobs().catch(() => {}); }));
    router.post('/resolve', handle((req, res) => { const { entity, chosen } = z.object({ entity: z.string().max(100), chosen: z.string().max(43) }).strict().parse(req.body); const sync = this.manager.getSelfHostedSync(); sync.resolve(entity, chosen); res.json(sync.status()); void sync.flushIndexJobs().catch(() => {}); }));
    router.post('/inspect', handle((req, res) => { const { entity } = z.object({ entity: z.string().max(100) }).strict().parse(req.body); res.json(this.manager.getSelfHostedSync().inspect(entity)); }));
    router.post('/inspect-work', handle((req, res) => { const { project, list } = z.object({ project: z.string().min(1).max(4096), list: z.string().min(1).max(256) }).strict().parse(req.body); res.json(this.manager.getSelfHostedSync().inspectWork(project, list)); }));
    app.use('/api/self-hosted-sync', router);
  }
}
