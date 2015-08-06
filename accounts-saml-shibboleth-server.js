if (!Accounts.saml) {
  Accounts.saml = {};
}

var Fiber = Npm.require('fibers');
var connect = Npm.require('connect');
RoutePolicy.declare('/_saml/', 'network');

Accounts.registerLoginHandler(function(loginRequest) {

  if(!loginRequest.saml || !loginRequest.credentialToken) {
    return undefined;
  }

  var loginResult = Accounts.saml.retrieveCredential(loginRequest.credentialToken);
  if(loginResult && loginResult.profile && loginResult.profile.email){
    var user = Meteor.users.findOne({'emails.address':loginResult.profile.email});
    if(!user) {
        Accounts.saml.debugLog('saml_server.js', '19', 'Could not find an existing user with supplied email', true);
        throw new Error("Could not find an existing user with supplied email " + loginResult.profile.email);
    }

    var stampedToken = Accounts._generateStampedLoginToken();
    var hashStampedToken = Accounts._hashStampedToken(stampedToken);

    Meteor.users.update(user,
      {$push: {'services.resume.loginTokens': hashStampedToken}}
    );

    Accounts.saml.debugLog('saml_server.js', '30', 'registerLoginHandler user._id, stampedToken: ' + user._id +',' + stampedToken.token, false);

    //sending token along with the userId
    return {
        userId: user._id,
        token: stampedToken.token
    };

  }else{
    Accounts.saml.debugLog('saml_server.js', '39', 'Throw SAML Profile did not contain an email address', true);
    throw new Error("SAML Profile did not contain an email address");
  }
});

Accounts.saml._loginResultForCredentialToken = {};

Accounts.saml.hasCredential = function(credentialToken) {
  return _.has(Accounts.saml._loginResultForCredentialToken, credentialToken);
}

Accounts.saml.retrieveCredential = function(credentialToken) {
  var result = Accounts.saml._loginResultForCredentialToken[credentialToken];
  delete Accounts.saml._loginResultForCredentialToken[credentialToken];
  return result;
}

// Listen to incoming OAuth http requests
WebApp.connectHandlers.use(function(req, res, next) {
    // Need to create a Fiber since we're using synchronous http calls and nothing
    // else is wrapping this in a fiber automatically

    if(req.method === 'POST'){
        var fullBody = '';
        req.on('data', function (chunk) {
            // Do something with `chunk` here
            fullBody += chunk.toString();
        });

        req.on('end', function() {
            req.body = { SAMLResponse : decodeURIComponent(fullBody.replace('SAMLResponse=',''))};
            Fiber(function () {
                middleware(req, res, next);
            }).run();
        });
    }
    else {
        Fiber(function () {
            middleware(req, res, next);
        }).run();
    }
});

middleware = function (req, res, next) {
  // Make sure to catch any exceptions because otherwise we'd crash
  // the runner
  try {
    var samlObject = samlUrlToObject(req.url);
    if(!samlObject || !samlObject.serviceName){
      next();
      return;
    }

    if(!samlObject.actionName) {
        Accounts.saml.debugLog('saml_server.js', '93', 'Throw Missing SAML action', true);
        throw new Error("Missing SAML action");
    }

    var service = _.find(Meteor.settings.saml, function(samlSetting){
      return samlSetting.provider === samlObject.serviceName;
    });

    // Skip everything if there's no service set by the saml middleware
    if (!service) {
        Accounts.saml.debugLog('saml_server.js', '103', "Throw Unexpected SAML service " + samlObject.serviceName, true);
        throw new Error("Unexpected SAML service " + samlObject.serviceName);
    }

    if(samlObject.actionName === "authorize"){
      //Truby, change our meteadatafile to remove the /1ed79ec15dfd from id.
      service.callbackUrl = Meteor.absoluteUrl("_saml/validate/"+service.provider+"/1ed79ec15dfd"); //samlObject.credentialToken); //I added the id at end may not need it.
      service.id = samlObject.credentialToken;
      _saml = new SAML(service);
      _saml.getAuthorizeUrl(req, function (err, url) {
        if(err) {
            Accounts.saml.debugLog('saml_server.js', '114', "Throw Unable to generate authorize url", true);
            throw new Error("Unable to generate authorize url");
        }
        res.writeHead(302, {'Location': url});
        res.end();
      });
    }else if (samlObject.actionName === "validate"){
      _saml = new SAML(service);
        //decrypt response first, then validate the decrypted response
        var decryptedResponse = _saml.decryptSAMLResponse(req.body.SAMLResponse);
        _saml.validateResponse(decryptedResponse, function (err, profile, loggedOut) {
            if (err) {
                Accounts.saml.debugLog('saml_server.js', '126', "Throw Unable to validate response url", true);
                throw new Error("Unable to validate response url");
            }

            var credentialToken = profile.inResponseToId || profile.InResponseTo || samlObject.credentialToken;
            if (!credentialToken) {
                Accounts.saml.debugLog('saml_server.js', '132', "Throw Unable to determine credentialToken", true);
                throw new Error("Unable to determine credentialToken");
            }

            //Accounts.saml keys are hasCredential, retrieveCredential  TV
            Accounts.saml._loginResultForCredentialToken[credentialToken] = {
                profile: profile
            };

            Accounts.saml.debugLog('saml_server.js', '141', 'closePopup being called.  CredentialToken: ' + credentialToken, false);

            closePopup(res);
        });
    }else {
      Accounts.saml.debugLog('saml_server.js', '146',"Throw Unexpected SAML action " + samlObject.actionName, true);
      throw new Error("Unexpected SAML action " + samlObject.actionName);
    }
  } catch (err) {
    closePopup(res, err);
  }
};

var samlUrlToObject = function (url) {
    Accounts.saml.debugLog('saml_server.js', '155',"samlUtrlToObject: " + url, false);
  // req.url will be "/_saml/<action>/<service name>/<credentialToken>"
  if(!url)
    return null;

  var splitPath = url.split('/');

  // Any non-saml request will continue down the default
  // middlewares.
  if (splitPath[1] !== '_saml')
    return null;

  return {
    actionName:splitPath[2],
    serviceName:splitPath[3],
    credentialToken:splitPath[4]
  };
};

var closePopup = function(res, err) {
   res.writeHead(200, {'Content-Type': 'text/html'});

    var content = '<html><head><script>window.close()</script></head></html>';
    if(err) {
        Accounts.saml.debugLog('saml_server.js', '179',"Throw error: " + err.reason, true);
        content = '<html><body><h2>Sorry, an error occured</h2><div>' + err + '</div><a onclick="window.close();">Close Window</a></body></html>';
    }

    res.end(content, 'utf-8');
};