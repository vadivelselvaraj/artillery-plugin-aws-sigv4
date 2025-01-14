'use strict';

var aws = require('aws-sdk'),
    L = require('lodash'),
    url = require('url'),
    traverse = require('traverse'),
    esprima = require('esprima'),

    constants = {
        PLUGIN_PREFIX: 'artillery-plugin-',
        PLUGIN_NAME: 'aws-sigv4',
        PLUGIN_PARAM_SERVICE_NAME: 'serviceName',
        THE: 'The "',
        CONFIG_REQUIRED: '" plugin requires configuration under [script].config.plugins.',
        PARAM_REQUIRED: '" parameter is required',
        PARAM_MUST_BE_STRING: '" param must have a string value',
        HEADER_AUTHORIZATION: 'Authorization',
        ERROR: ' ERROR (signature will not be added): '
    },
    messages = {
        pluginConfigRequired: constants.THE + constants.PLUGIN_NAME + constants.CONFIG_REQUIRED + constants.PLUGIN_NAME,
        pluginParamServiceNameRequired: constants.THE + constants.PLUGIN_PARAM_SERVICE_NAME + constants.PARAM_REQUIRED,
        pluginParamServiceNameMustBeString: constants.THE + constants.PLUGIN_PARAM_SERVICE_NAME + constants.PARAM_MUST_BE_STRING,
        sdkConfigInvalidError: constants.PLUGIN_PREFIX + constants.PLUGIN_NAME + constants.ERROR
    },
    impl = {
        validateScriptConfig: function(scriptConfig) {
            // Validate that plugin config exists
            if (!(scriptConfig && scriptConfig.plugins && constants.PLUGIN_NAME in scriptConfig.plugins)) {
                throw new Error(messages.pluginConfigRequired);
            }
            // Validate NAMESPACE
            if (!(constants.PLUGIN_PARAM_SERVICE_NAME in scriptConfig.plugins[constants.PLUGIN_NAME])) {
                throw new Error(messages.pluginParamServiceNameRequired);
            } else if (!('string' === typeof scriptConfig.plugins[constants.PLUGIN_NAME][constants.PLUGIN_PARAM_SERVICE_NAME] ||
                scriptConfig.plugins[constants.PLUGIN_NAME][constants.PLUGIN_PARAM_SERVICE_NAME] instanceof String)) {
                throw new Error(messages.pluginParamServiceNameMustBeString);
            }
        },
        validateSdkConfig: function(credentials, region) {
            var result = false;
            if (!credentials) {
                console.log([
                    messages.sdkConfigInvalidError,
                    'credentials not obtained.  ',
                    'Ensure the aws-sdk can obtain valid credentials.'
                ].join(''));
            } else if (
                !(
                    (credentials.accessKeyId && credentials.secretAccessKey) ||
                    credentials.roleArn
                )
            ) {
                console.log([
                    messages.sdkConfigInvalidError,
                    'valid credentials not loaded.  ',
                    'Ensure the aws-sdk can obtain credentials with either both accessKeyId and ',
                    'secretAccessKey attributes (optionally sessionToken) or a roleArn attribute.'
                ].join(''));
            } else if (!region) {
                console.log([
                    messages.sdkConfigInvalidError,
                    'valid region not configured.  ',
                    'Ensure the aws-sdk can obtain a valid region for use in signing your requests.  ',
                    'Consider exporting or setting AWS_REGION.  Alternatively specify a default ',
                    'region in your ~/.aws/config file.'
                ].join(''));
            } else {
                result = true;
            }
            return result;
        },
        renderVariables: function(str, vars) {
            var RX = /{{{?[\s$\w\.\[\]\'\"]+}}}?/g,
                rxmatch,
                varName,
                templateStr,
                varValue,
                result = str.substring(0, str.length),
                matches = str.match(RX);

            // Special case for handling integer/boolean/object substitution:
            //
            // Does the template string contain one variable and nothing else?
            // e.g.: "{{ myvar }" or "{{    myvar }", but NOT " {{ myvar }"
            // If so, we treat it as a special case.
            if (matches && matches.length === 1) {
                if (matches[0] === str) {
                    // there's nothing else in the template but the variable
                    varName = str.replace(/{/g, '').replace(/}/g, '').trim();
                    return L.get(vars, varName) || '';
                }
            }

            while (result.search(RX) > -1) {
                templateStr = result.match(RX)[0];
                varName = templateStr.replace(/{/g, '').replace(/}/g, '').trim();
                varValue = L.get(vars, varName);

                if (typeof varValue === 'object') {
                    varValue = JSON.stringify(varValue);
                }
                result = result.replace(templateStr, varValue);
            }

            return result;
        },

        template: function (o, context) {
            var result, funcCallRegex, funcName, args, syntax, match;

            if (typeof o === 'undefined') {
                return undefined;
            }

            if (o.constructor === Object) {
                result = traverse(o).map(function (x) {
                    if (typeof x === 'string') {
                        this.update(this.template(x, context));
                    } else {
                        return x;
                    }
                });
            } else if (typeof o === 'string') {
                if (!/{{/.test(o)) {
                    return o;
                }

                funcCallRegex = /{{\s*(\$[A-Za-z0-9_]+\s*\(\s*.*\s*\))\s*}}/;
                match = o.match(funcCallRegex);

                if (match) {
                    // This looks like it could be a function call:
                    syntax = esprima.parse(match[1]);
                    // TODO: Use a proper schema for what we expect here
                    if (syntax.body && syntax.body.length === 1 &&
                        syntax.body[0].type === 'ExpressionStatement') {
                        funcName = syntax.body[0].expression.callee.name;
                        args = L.map(syntax.body[0].expression.arguments, function (arg) {
                            return arg.value;
                        });
                        if (funcName in context.funcs) {
                            return this.template(o.replace(funcCallRegex, context.funcs[funcName].apply(null, args)), context);
                        }
                    }
                } else {
                    if (!o.match(/{{/)) {
                        return o;
                    }

                    result = this.renderVariables(o, context.vars);
                }
            } else {
                return o;
            }

            return result;
        },

        addAmazonSignatureV4: function (serviceName, requestParams, context, ee, callback) {
            var targetUrl = url.parse(requestParams.uri || requestParams.url),
                credentials = aws.config.credentials,
                region = aws.config.region,
                end = new aws.Endpoint(targetUrl.hostname),
                req = new aws.HttpRequest(end),
                signer,
                header;

            if (impl.validateSdkConfig(credentials, region)) {
                req.method = requestParams.method;
                req.path = targetUrl.path;
                req.region = region;
                req.headers.Host = end.host;

                for (header in requestParams.headers) {
                    req.headers[header] = requestParams.headers[header];
                }

                if (requestParams.body) {
                    req.body = this.template(requestParams.body, context);
                } else if (requestParams.json) {
                    req.body = this.template(JSON.stringify(requestParams.json), context);
                }

                signer = new aws.Signers.V4(req, serviceName);
                signer.addAuthorization(credentials, new Date());

                for (header in req.headers) {
                    requestParams.headers[header] = req.headers[header];
                }
            }
            callback();
        }
    },
    api = {
        init: function(scriptConfig, eventEmitter) {
            var AwsSigV4Plugin = function(scriptConfig, eventEmitter) {
                var serviceName,
                    sdkCredentials = false,
                    sdkCredentialsError,
                    p;
                impl.validateScriptConfig(scriptConfig);
                serviceName = scriptConfig.plugins[constants.PLUGIN_NAME][constants.PLUGIN_PARAM_SERVICE_NAME];
                aws.config.getCredentials(function(err) {
                    if (err) {
                        sdkCredentialsError = err;
                    } else {
                        sdkCredentials = true;
                        if (p) {
                            impl.addAmazonSignatureV4(serviceName, p.requestParams, p.context, p.ee, p.callback);
                        }
                    }
                });
                if (!scriptConfig.processor) {
                    scriptConfig.processor = {};
                }
                scriptConfig.processor.addAmazonSignatureV4 = function(requestParams, context, ee, callback) {
                    if (!sdkCredentials) {
                        if (sdkCredentialsError) {
                            console.log([
                                messages.sdkConfigInvalidError,
                                'credentials fetch error.  ',
                                'Ensure the aws-sdk can obtain valid credentials.  ',
                                'Error: ',
                                sdkCredentialsError.message
                            ].join(''));
                        } else {
                            p = { requestParams: requestParams, context: context, ee: ee, callback: callback };
                        }
                    } else {
                        impl.addAmazonSignatureV4(serviceName, requestParams, context, ee, callback);
                    }
                };
            };
            return new AwsSigV4Plugin(scriptConfig, eventEmitter);
        }
    };

module.exports = api.init;

/* test-code */
module.exports.constants = constants;
module.exports.messages = messages;
module.exports.impl = impl;
module.exports.api = api;
/* end-test-code */
