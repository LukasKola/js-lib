import type { AxiosResponse, AxiosRequestConfig, AxiosError } from 'axios';
import Axios from 'axios';
import { ReturnCodes } from './ReturnCodes';
import type { IApiResult } from './data/IApiResult';
import { HttpMethod } from './HttpMethod';
import { CredentialsSessionHandler } from './CredentialsSessionHandler';
import { AnonymousSessionHandler } from './AnonymousSessionHandler';
import { ApiMethods } from './ApiMethods';
import { OAuthSessionHandler } from './OAuthSessionHandler';
import type { TUnionError } from './exceptions/HttpRequestError';
import { HttpRequestError } from './exceptions/HttpRequestError';
import type { ITokenData, TInputData } from './interfaces/ITokenData';
import * as base64url from 'universal-base64url';
import type { TFolderName } from './constants/FolderNames';
import ErrorHelper from './helpers/ErrorHelper';
import type { IApiLoginResponse } from './data/IApiLoginResponse';
import type { TransformItemFormats } from './enumerations/TransformItemFormats';

export interface ISessionHandler {
    invalidateSessionId(sessionId: string, callback: () => void): void;
    getSessionId(connection: ApiConnection, callback: (sessionId: string) => void): void;
    lastSuccessfulLoginResponse?: IApiLoginResponse;
}

export class ApiConnection {
    private readonly svcUri: string;
    private readonly baseUri: string;
    public readonly sessionHandler: ISessionHandler;
    private readonly errorCallback: ((error: TUnionError, data?: TInputData | null) => void) | undefined;
    private readonly supportGetItemPreviewMethod: boolean;

    private sessionId: string | null;

    constructor(apiServiceUri: string, sessionHandler: ISessionHandler, errorCallback?: (error: TUnionError, data?: TInputData | null) => void, supportGetItemPreviewMethod?: boolean) {
        if (!apiServiceUri) {
            throw new Error("The argument 'apiServiceUri' cannot be empty.");
        }
        if (apiServiceUri.length < 8 || (apiServiceUri.substr(0, 8).toLowerCase() !== 'https://' && apiServiceUri.substr(0, 7).toLowerCase() !== 'http://')) {
            throw new Error("Api service uri must start either with 'https://' or with 'http://'.");
        }

        if (apiServiceUri.substr(apiServiceUri.length - 4).toLowerCase() === '.svc') {
            this.svcUri = apiServiceUri;
            const apiServiceOptions = ['/API.svc', '/InsecureAPI.svc', '/WcfService/Service.svc'];
            const apiOption = apiServiceOptions.find((option) => option.toLowerCase() === apiServiceUri.substr(apiServiceUri.length - option.length).toLowerCase()) || '';
            this.baseUri = apiServiceUri.substr(0, apiServiceUri.length - apiOption.length);
        } else {
            this.baseUri = ApiConnection.normalizeWsUrl(apiServiceUri) || apiServiceUri;

            if (apiServiceUri.substr(0, 8).toLowerCase() === 'https://') {
                this.svcUri = this.baseUri + '/API.svc';
            } else {
                this.svcUri = this.baseUri + '/InsecureAPI.svc';
            }
        }

        this.sessionHandler = sessionHandler;
        this.errorCallback = errorCallback;
        this.sessionId = null;
        this.supportGetItemPreviewMethod = supportGetItemPreviewMethod ?? false;
    }

    get supportsGetItemPreviewMethod() {
        return this.supportGetItemPreviewMethod;
    }

    static create(
        apiServiceUri: string,
        username: string,
        passwordHash: string,
        appVersion: string,
        clientMachineIdentifier: string,
        clientMachineName: string,
        errorCallback?: (error: TUnionError) => void,
        supportGetItemPreviewMethod?: boolean
    ): ApiConnection {
        return new ApiConnection(apiServiceUri, new CredentialsSessionHandler(username, passwordHash, appVersion, clientMachineIdentifier, clientMachineName, errorCallback), errorCallback, supportGetItemPreviewMethod);
    }

    static createAnonymous(apiServiceUri: string, errorCallback?: (error: TUnionError) => void): ApiConnection {
        return new ApiConnection(apiServiceUri, new AnonymousSessionHandler(), errorCallback);
    }

    static createUsingOAuth(
        apiServiceUri: string,
        username: string,
        clientId: string,
        clientSecret: string,
        refreshToken: string,
        accessToken: string,
        appVersion: string,
        errorCallback?: (error: TUnionError) => void,
        refreshTokenCallback?: (tokenData: ITokenData) => void,
        supportGetItemPreviewMethod?: boolean
    ): ApiConnection {
        return new ApiConnection(apiServiceUri, new OAuthSessionHandler(username, clientId, clientSecret, refreshToken, accessToken, appVersion, errorCallback, refreshTokenCallback), errorCallback, supportGetItemPreviewMethod);
    }

    static normalizeWsUrl(wsUrl: string | null): string | null {
        if (wsUrl && wsUrl.endsWith('/')) {
            wsUrl = wsUrl.substring(0, wsUrl.length - 1);
        }

        return wsUrl;
    }

    static isCloudUrl(wsUrl: string, allowDev: boolean) {
        const url = new URL(wsUrl);
        const hosts = new Set();
        hosts.add("hosting.eway-crm.com");
        hosts.add("free.eway-crm.com");
        hosts.add("hosting.eway-crm.us");
        hosts.add("hosting-vh39276.eway-crm.us");
        hosts.add("free.eway-crm.us");

        if (allowDev) {
            hosts.add("free.eway-crm.dev");
            hosts.add("hosting.eway-crm.dev");
            hosts.add("localhost");
        }

        return hosts.has(url.host);
    }

    get wsUrl(): string {
        return this.baseUri;
    }


    /**
     * Ensures that the current session isn't null and if it is, generates a new one
     */
    readonly ensureLogin = (): Promise<void> => {
        return new Promise<void>((resolve, reject) => {
            if (!this.sessionId) {
                const sessionCallback = (sessionId: string): void => {
                    if (sessionId) {
                        this.sessionId = sessionId;
                        resolve();
                    }
                    reject("Session Id cannot be empty");
                };

                this.sessionHandler.getSessionId(this, sessionCallback);
            } else {
                resolve();
            }
        });
    };

    readonly createOpenLink = (isDevEnvironment: boolean, folderName: TFolderName, guid?: string, fileAs?: string): string => {
        const ws = base64url.encode(this.baseUri);
        let legacyLink = "eway://" + folderName;
        if (guid) {
            legacyLink += "/" + guid?.toLowerCase();
        }

        const domain = isDevEnvironment ? 'open.eway-crm.dev' : 'open.eway-crm.com';

        legacyLink = base64url.encode(legacyLink);
        let url = "https://" + domain + "/?ws=" + ws + "&l=" + legacyLink;

        if (fileAs) {
            url += "&n=" + encodeURIComponent(fileAs);
        }

        return url;
    };

       /**
     * Creates a promise for async file upload using binary stream
     * @param file Single file to be uploaded.
     * @param data Additional data to be sent as URL parameters
     * @param methodName API method name. Ex. 'SaveBinaryAttachment'.
     * @param config Optional. Additional config for the request.
     * @param catchGlobally Optional. If true, raises this the global error handler each time the promise is rejected.
     */
    readonly askCustomUploadMethod = (
        file: File,
        data: Record<string, string>,
        methodName: string,
        config?: AxiosRequestConfig,
        catchGlobally?: boolean
    ): Promise<IApiResult> => {
        return new Promise<IApiResult>((resolve, reject) => {
            const errClb = catchGlobally
                ? (e: TUnionError | IApiResult): void => {
                    reject(e);
                    throw e;
                }
                : reject;

            this.callCustomUploadMethod(file, data, methodName, resolve, errClb, errClb, config);
        });
    };

    /**
     * Creates a promise for async file upload using binary stream
     * @param itemGuid Item identificator. Ex. '9ac561be-9b7d-4938-8e55-4cce97142483'.
     * @param fileName File name, ex. 'picture.img'.
     * @param file Single file to be uploaded.
     * @param config Optional. Additional config for the request.
     * @param catchGlobally Optional. If true, raises this the global error handler each time the promise is rejected.
     */

    readonly askUploadMethod = (itemGuid: string, fileName: string, file: File, config?: AxiosRequestConfig, catchGlobally?: boolean): Promise<IApiResult> => {
        return new Promise<IApiResult>((resolve, reject) => {
            const errClb = catchGlobally
                ? (e: TUnionError | IApiResult): void => {
                    reject(e);
                    throw e;
                }
                : reject;

            this.callUploadMethod(itemGuid, fileName, file, resolve, errClb, errClb, config);
        });
    };

    /**
     * 
     * @param file File to be uploaded
     * @param data Additional data to be sent as URL parameters
     * @param methodName API method name. Ex. 'SaveBinaryAttachment'.
     * @param successCallback Handler callback when the method executes well. Gets the whole response JSON object as the only argument.
     * @param unsuccessCallback Optional. Handler callback for eWay-API app level failures. Gets the whole response JSON object as the only argument. If not supplied, the global error handler is used.
     * @param errorCallback Optional. Handler callback for any other failures. If not supplied, the global error handler is used.
     * @param config Optional. Additional config for the request.
     */

    readonly callCustomUploadMethod = (
        file: File,
        data: Record<string, string>,
        methodName: string,
        successCallback: (res: IApiResult) => void,
        unsuccessCallback?: (e: IApiResult) => void,
        errorCallback?: (e: TUnionError) => void,
        config?: AxiosRequestConfig,
    ) => {
        const noSessionCallback = (): void => {
            this.sessionHandler.getSessionId(this, (newSessionId) => {
                this.sessionId = newSessionId;
                this.callCustomUploadMethod(file, data, methodName, successCallback, unsuccessCallback, errorCallback, config);
            });
        };

        const sessionId = this.sessionId;
        if (!sessionId) {
            noSessionCallback();
            return;
        }

        const unsuccessClb = (result: IApiResult): void => {
            if (result.ReturnCode === ReturnCodes.rcBadSession) {
                this.sessionId = null;
                this.sessionHandler.invalidateSessionId(sessionId, noSessionCallback);
                return;
            }

            if (unsuccessCallback) {
                unsuccessCallback(result);
            } else {
                const error = new Error('Unhandled connection return code ' + result.ReturnCode + ': ' + result.Description);
                if (this.errorCallback) {
                    this.errorCallback(error);
                } else {
                    throw error;
                }
            }
        };

        const errorClb = (error: TUnionError): void => {
            let err = new Error('Unhandled connection error when calling ' + methodUrl + ': ' + ErrorHelper.stringifyError(error));
            if ('statusCode' in error && error.statusCode === 413) {
                err = new Error('The file has exceeded the maximum allowed file size for uploading. You can contact your IT administrator or eWay-CRM support if you would like to increase the limit.');
            }

            if (errorCallback) {
                errorCallback(err);
            } else if (this.errorCallback) {
                this.errorCallback(err);
            } else {
                throw err;
            }
        };

        const dataUrlSearchParams = new URLSearchParams(data);
        const methodUrl = `${this.svcUri}/${methodName}?sessionId=${this.sessionId}&${dataUrlSearchParams.toString()}`;
        const promise = Axios.post<IApiResult>(methodUrl, data, config);

        ApiConnection.handleCallPromise(promise, successCallback, unsuccessClb, errorClb);
    };

    /**
     * Asynchronously uploads file using binary stream
     * @param itemGuid Item identificator. Ex. '9ac561be-9b7d-4938-8e55-4cce97142483'.
     * @param fileName File name, ex. 'picture.img'.
     * @param file Single file to be uploaded.
     * @param successCallback Handler callback when the method executes well. Gets the whole response JSON object as the only argument.
     * @param unsuccessCallback Optional. Handler callback for eWay-API app level failures. Gets the whole response JSON object as the only argument. If not supplied, the global error handler is used.
     * @param errorCallback Optional. Handler callback for any other failures. If not supplied, the global error handler is used.
     * @param config Optional. Additional config for the request.
     */

    readonly callUploadMethod = (
        itemGuid: string,
        fileName: string,
        file: File,
        successCallback: (res: IApiResult) => void,
        unsuccessCallback?: (e: IApiResult) => void,
        errorCallback?: (e: TUnionError) => void,
        config?: AxiosRequestConfig,
    ) => {
        this.callCustomUploadMethod(file, { itemGuid, fileName }, ApiMethods.saveBinaryAttachment, successCallback, unsuccessCallback, errorCallback, config);
    };

    /**
     * Creates a promise for async API method call.
     * @param methodName API method name. Ex. 'GetUsers'.
     * @param data Input data or empty object. Ex. {transmitObject: {FileAs: 'Peter File'}} or {itemGuids: ['9ac561be-9b7d-4938-8e55-4cce97142483']}.
     * @param httpMethod Optional. The used HTTP method. POST or GET. Default is POST.
     * @param catchGlobally Optional. If true, raises this the global error handler each time the promise is rejected.
     */
    readonly askMethod = <TResult extends IApiResult>(methodName: string, data: TInputData, httpMethod?: HttpMethod, catchGlobally?: boolean): Promise<TResult> => {
        return new Promise<TResult>((resolve, reject) => {
            const errClb = catchGlobally
                ? (e: TUnionError | TResult): void => {
                    reject(e);
                    throw e;
                }
                : reject;
            this.callMethod<TResult>(methodName, data, resolve, errClb, httpMethod, errClb);
        });
    };

    /**
     * Asynchronously calls API method with automatically added session data.
     * @param methodName API method name. Ex. 'GetUsers'.
     * @param data Input data or empty object. Ex. {transmitObject: {FileAs: 'Peter File'}} or {itemGuids: ['9ac561be-9b7d-4938-8e55-4cce97142483']}.
     * @param successCallback Handler callback when the method executes well. Gets the whole response JSON object as the only argument.
     * @param unsuccessCallback Optional. Handler callback for eWay-API app level failures. Gets the whole response JSON object as the only argument. If not supplied, the global error handler is used.
     * @param httpMethod Optional. The used HTTP method. POST or GET. Default is POST.
     * @param errorCallback Optional. Handler callback for any other failures. If not supplied, the global error handler is used.
     */
    readonly callMethod = <TResult extends IApiResult>(
        methodName: string,
        data: TInputData,
        successCallback: (result: TResult) => void,
        unsuccessCallback?: (result: TResult) => void,
        httpMethod?: HttpMethod,
        errorCallback?: (error: TUnionError) => void
    ): void => {
        if (!httpMethod) {
            httpMethod = HttpMethod.post;
        }
        const noSessionCallback = (): void => {
            this.sessionHandler.getSessionId(this, (newSessionId) => {
                this.sessionId = newSessionId;
                this.callMethod(methodName, data, successCallback, unsuccessCallback, httpMethod, errorCallback);
            });
        };

        const sessionId = this.sessionId;
        if (!sessionId) {
            noSessionCallback();
            return;
        }

        data.sessionId = sessionId;
        const unsuccessClb = (result: TResult): void => {
            if (result.ReturnCode === ReturnCodes.rcBadSession) {
                this.sessionId = null;
                if (methodName !== ApiMethods.logOut) {
                    this.sessionHandler.invalidateSessionId(sessionId, noSessionCallback);
                    return;
                }
            }
            if (unsuccessCallback) {
                unsuccessCallback(result);
            } else {
                const error = new Error('Unhandled connection return code ' + result.ReturnCode + ': ' + result.Description);
                if (this.errorCallback) {
                    this.errorCallback(error, data);
                } else {
                    throw error;
                }
            }
        };

        const successClb =
            methodName !== ApiMethods.logOut
                ? successCallback
                : (result: TResult): void => {
                    this.sessionId = null;
                    successCallback(result);
                };

        this.callWithoutSession(methodName, data, successClb, unsuccessClb, null, httpMethod, errorCallback);
    };

    readonly callWithoutSession = <TResult extends IApiResult>(
        methodName: string,
        data: TInputData | null,
        successCallback: (result: TResult) => void,
        unsuccessCallback: (result: TResult) => void,
        headers?: Record<string, string> | null,
        httpMethod?: HttpMethod,
        errorCallback?: (error: TUnionError) => void
    ): void => {
        if (!httpMethod) {
            httpMethod = HttpMethod.post;
        }

        const methodUrl = this.svcUri + '/' + methodName;
        let config: AxiosRequestConfig | undefined;
        if (!!headers) {
            config = {
                headers,
                withCredentials: this.supportGetItemPreviewMethod ?? methodName == ApiMethods.logIn
            };
        }
        let promise: Promise<AxiosResponse<TResult>>;
        switch (httpMethod) {
            case HttpMethod.get:
                if (data) {
                    throw new Error('Calling api get method with data specified does not make any sense.');
                }
                promise = Axios.get(methodUrl, config);
                break;
            case HttpMethod.post:
                promise = Axios.post(methodUrl, data, config);
                break;
            default:
                throw new Error(`Unknown http method '${httpMethod as string}'.`);
        }

        const errorClb = (error: TUnionError): void => {
            if (errorCallback) {
                try {
                    errorCallback(error);
                } catch (e) {
                    if (this.errorCallback) {
                        this.errorCallback(e as TUnionError, data);
                    } else {
                        throw e;
                    }
                }
            } else {
                const err = new Error('Unhandled connection error when calling ' + methodUrl + ': ' + ErrorHelper.stringifyError(error));
                if (this.errorCallback) {
                    this.errorCallback(err, data);
                } else {
                    throw err;
                }
            }
        };

        ApiConnection.handleCallPromise(promise, successCallback, unsuccessCallback, errorClb);
    };

    readonly getItemPreviewGetMethodUrl = (folderName: string, itemGuid: string, itemVersion?: number): string => {
        return this.svcUri + '/' + ApiMethods.getItemPreview + '?folderName=' + encodeURIComponent(folderName) + '&itemGuid=' + encodeURIComponent(itemGuid) + (!!itemVersion || itemVersion === 0 ? '&itemVersion=' + encodeURIComponent(itemVersion.toString()) : '');
    };

    readonly getEmailAttachmentGetMethodUrl = (itemGuid: string, contentId: string): string => {
        return this.svcUri + '/' + ApiMethods.getEmailAttachment + '?itemGuid=' + encodeURIComponent(itemGuid) + '&contentId=' + encodeURIComponent(contentId);
    };

    readonly getAllEmailAttachmentsZipGetMethodUrl = (itemGuid: string): string => {
        return this.svcUri + '/' + ApiMethods.getAllEmailAttachments + '?itemGuid=' + encodeURIComponent(itemGuid);
    };

    readonly getBinaryAttachmentGetMethodUrl = (itemGuid: string, revision?: number): string => {
        if (typeof revision === 'number') {
            return this.svcUri + '/' + ApiMethods.getBinaryAttachment + '?itemGuid=' + encodeURIComponent(itemGuid) + `&revision=${revision}`;
        }

        return this.svcUri + '/' + ApiMethods.getBinaryAttachmentLatestRevision + '?itemGuid=' + encodeURIComponent(itemGuid);
    };

    readonly getTransformItemMethodUrl = (itemGuid: string, folderName: string, transformationGuid: string, outputFormat: TransformItemFormats): string => {
        return `${this.svcUri}/${ApiMethods.transformItem}?itemGuid=${encodeURIComponent(itemGuid)}&itemFolderName=${encodeURIComponent(folderName)}&transformationGuid=${encodeURIComponent(transformationGuid)}&outputFormat=${outputFormat}`;
    };

    readonly getXsltTransformationDefinitionMethodUrl = (transformationGuid: string): string => {
        return `${this.svcUri}/${ApiMethods.getXsltTransormationDefinition}?itemGuid=${encodeURIComponent(transformationGuid)}`;
    };

    readonly getActiveSessionId = (): string | null => {
        return this.sessionId;
    };

    readonly setActiveSessionId = (sessionId: string | null) => {
        this.sessionId = sessionId;
    };

    private static handleCallPromise<TResult extends IApiResult>(
        call: Promise<AxiosResponse<TResult>>,
        successCallback: (result: TResult) => void,
        unsuccessCallback: (result: TResult) => void,
        errorCallback: (error: TUnionError) => void
    ): void {
        call.then((response: AxiosResponse<TResult>) => {
            if (response.status === 200) {
                if (response.data.ReturnCode === ReturnCodes.rcSuccess) {
                    successCallback(response.data);
                } else {
                    unsuccessCallback(response.data);
                }
            } else {
                errorCallback(new HttpRequestError(response.status, response.statusText));
            }
        }).catch((error: AxiosError) => {
            if (error.response) {
                errorCallback(new HttpRequestError(error.response.status, error.response.statusText));
                return;
            }

            errorCallback(error);
        });
    }
}
