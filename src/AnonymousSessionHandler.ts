/* eslint-disable @typescript-eslint/no-unused-vars */
import type { ApiConnection, ISessionHandler } from './ApiConnection';

export class AnonymousSessionHandler implements ISessionHandler {
    readonly getSessionId = (connection: ApiConnection, callback: (sessionId: string) => void): void => {
        throw new Error('With anonymous session handler, use only connection methods without session.');
    };

    readonly invalidateSessionId = (sessionId: string, callback: () => void): void => {
        throw new Error('With anonymous session handler, use only connection methods without session.');
    };
}
