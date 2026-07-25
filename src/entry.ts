import { Runtime } from 'foldkit'

import { overlay } from '@foldkit/devtools'

import { Message, Model, init, managedResources, subscriptions, update, view } from './main'

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  managedResources,
  subscriptions,
  container: document.getElementById('root'),
  devTools: {
    overlay,
    Message,
  },
})

/**
 * On a first-ever visit, coi-serviceworker.js (registered in index.html)
 * registers its service worker and then force-reloads the page once it's
 * active, so COOP/COEP headers actually take effect. If the app has
 * already started downloading model weights (several MB) by then, that
 * reload throws the in-flight download away and it restarts from scratch
 * after reload -- looking like the model "never finishes loading" on a
 * slow connection. Waiting for service worker registration to settle
 * before mounting the app (and starting any downloads) avoids the wasted
 * download; it's a no-op when already cross-origin isolated or when a
 * service worker isn't relevant (e.g. plain HTTP during local dev).
 */
const waitForCoiToSettle = (): Promise<void> => {
  if (window.crossOriginIsolated || !window.isSecureContext || !navigator.serviceWorker) {
    return Promise.resolve()
  }
  return new Promise(resolve => {
    let settled = false
    const finish = (): void => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    navigator.serviceWorker.ready.then(finish).catch(finish)
    // Safety net in case registration hangs (e.g. an unusual environment
    // where 'ready' never resolves) -- don't block the app forever.
    setTimeout(finish, 1500)
  })
}

void waitForCoiToSettle().then(() => {
  Runtime.run(application)
})
