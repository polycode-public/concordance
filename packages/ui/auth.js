// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Cognito sign-in for the AWS form of the page: USER_PASSWORD_AUTH straight against the
// Cognito API with fetch. The id token stays in sessionStorage for the tab's life.

const KEY = "concordance.idToken";
const EXPIRY_MARGIN_MS = 60_000;

const $ = (id) => document.getElementById(id);
let memory = null;

function claims(token) {
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(part));
}

/** True when the token is malformed or expires within a minute. */
export function isExpired(token) {
  try {
    return claims(token).exp * 1000 < Date.now() + EXPIRY_MARGIN_MS;
  } catch {
    return true;
  }
}

function stored() {
  let token = memory;
  try {
    token ??= sessionStorage.getItem(KEY);
  } catch {
    // Storage is blocked: only the in-memory token counts.
  }
  return token && !isExpired(token) ? token : null;
}

function store(token) {
  memory = token;
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    // Storage is blocked: the token lives in memory until the page reloads.
  }
}

/** The stored id token while it is valid, else null. */
export const currentToken = () => stored();

/** Forgets the token, so the next signIn shows the form. */
export function signOut() {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing is stored when storage is blocked.
  }
}

/**
 * Calls Cognito InitiateAuth and resolves to the id token.
 * @param {{ region: string, clientId: string }} auth
 */
async function initiateAuth({ region, clientId }, username, password) {
  const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message ?? body.__type ?? `sign-in failed (${res.status})`);
  if (body.ChallengeName) {
    throw new Error(
      `sign-in needs ${body.ChallengeName}; the operator must set a permanent password`,
    );
  }
  return body.AuthenticationResult.IdToken;
}

/**
 * Resolves to a valid id token: the stored one, or one from the sign-in form.
 * @param {{ region: string, userPoolId: string, clientId: string }} auth
 */
export function signIn(auth) {
  const token = stored();
  if (token) return Promise.resolve(token);
  const form = $("signin");
  const message = $("signin-message");
  document.body.classList.add("signed-out");
  form.hidden = false;
  $("signin-user").focus();
  return new Promise((resolve) => {
    const submit = async (event) => {
      event.preventDefault();
      message.textContent = "Signing in…";
      try {
        const idToken = await initiateAuth(
          auth,
          $("signin-user").value,
          $("signin-password").value,
        );
        store(idToken);
        form.removeEventListener("submit", submit);
        form.reset();
        form.hidden = true;
        message.textContent = "";
        document.body.classList.remove("signed-out");
        resolve(idToken);
      } catch (err) {
        message.textContent = err.message;
      }
    };
    form.addEventListener("submit", submit);
  });
}
