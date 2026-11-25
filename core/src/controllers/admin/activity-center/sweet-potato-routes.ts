import type { ActivityRouteContext } from './types';

const store = require('../../../models/store');

export function mountSweetPotatoRoutes({ app, ctx, withAccount }: ActivityRouteContext): void {
    app.get('/api/activity-center/sweet-potato', withAccount(async (accountId: string) => {
        const detail = await ctx.provider.getSweetPotatoDetail(accountId);
        const automation = typeof store.getAutomation === 'function' ? store.getAutomation(accountId) : {};
        return { ...detail, autoClaim: automation?.potato_claim !== false };
    }));

    app.post('/api/activity-center/sweet-potato/seeds/claim', withAccount(
        (accountId: string) => ctx.provider.claimSweetPotatoDaily(accountId),
    ));

    app.post('/api/activity-center/sweet-potato/exchange', withAccount(
        (accountId: string, req: any) => ctx.provider.exchangeSweetPotatoGoods(accountId, req.body || {}),
    ));

    app.post('/api/activity-center/sweet-potato/share-boost', withAccount(
        (accountId: string) => ctx.provider.shareSweetPotatoBoost(accountId),
    ));

    app.post('/api/activity-center/sweet-potato/auto-claim', withAccount(async (accountId: string, req: any) => {
        const enabled = req.body?.enabled !== false;
        await ctx.provider.setAutomation(accountId, 'potato_claim', enabled);
        return { autoClaim: enabled };
    }));
}
