import generateETag from 'etag'
import fresh from 'fresh'
import consola from 'consola'

import { getContext } from '@nuxt/common'

export default ({ options, nuxt, renderRoute, resources }) => async function nuxtMiddleware(req, res, next) {
  // Get context
  const context = getContext(req, res)
  const url = decodeURI(req.url)

  res.statusCode = 200
  try {
    const result = await renderRoute(url, context)
    await nuxt.callHook('render:route', url, result, context)
    const {
      html,
      cspScriptSrcHashSet,
      error,
      redirected,
      getPreloadFiles
    } = result

    if (redirected) {
      nuxt.callHook('render:routeDone', url, result, context)
      return html
    }
    if (error) {
      res.statusCode = context.nuxt.error.statusCode || 500
    }

    // Add ETag header
    if (!error && options.render.etag) {
      const etag = generateETag(html, options.render.etag)
      if (fresh(req.headers, { etag })) {
        res.statusCode = 304
        res.end()
        nuxt.callHook('render:routeDone', url, result, context)
        return
      }
      res.setHeader('ETag', etag)
    }

    // HTTP2 push headers for preload assets
    if (!error && options.render.http2.push) {
      // Parse resourceHints to extract HTTP.2 prefetch/push headers
      // https://w3c.github.io/preload/#server-push-http-2
      const preloadFiles = getPreloadFiles()

      const { shouldPush, pushAssets } = options.render.http2
      const { publicPath } = resources.clientManifest

      const links = pushAssets
        ? pushAssets(req, res, publicPath, preloadFiles)
        : defaultPushAssets(preloadFiles, shouldPush, publicPath, options)

      // Pass with single Link header
      // https://blog.cloudflare.com/http-2-server-push-with-multiple-assets-per-link-header
      // https://www.w3.org/Protocols/9707-link-header.html
      if (links.length > 0) {
        res.setHeader('Link', links.join(', '))
      }
    }

    if (options.render.csp) {
      const { allowedSources, policies } = options.render.csp
      const cspHeader = options.render.csp.reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy'

      res.setHeader(cspHeader, getCspString({ cspScriptSrcHashSet, allowedSources, policies, isDev: options.dev }))
    }

    // Send response
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Accept-Ranges', 'none') // #3870
    res.setHeader('Content-Length', Buffer.byteLength(html))
    res.end(html, 'utf8')
    nuxt.callHook('render:routeDone', url, result, context)
    return html
  } catch (err) {
    /* istanbul ignore if */
    if (context && context.redirected) {
      consola.error(err)
      return err
    }

    next(err)
  }
}

const defaultPushAssets = (preloadFiles, shouldPush, publicPath, options) => {
  if (shouldPush && options.dev) {
    consola.warn('http2.shouldPush is deprecated. Use http2.pushAssets function')
  }

  const links = []
  preloadFiles.forEach(({ file, asType, fileWithoutQuery, modern }) => {
    // By default, we only preload scripts or css
    /* istanbul ignore if */
    if (!shouldPush && asType !== 'script' && asType !== 'style') {
      return
    }

    // User wants to explicitly control what to preload
    if (shouldPush && !shouldPush(fileWithoutQuery, asType)) {
      return
    }

    const crossorigin = options.build.crossorigin
    const cors = `${crossorigin ? ` crossorigin=${crossorigin};` : ''}`
    const ref = modern ? 'modulepreload' : 'preload'

    links.push(`<${publicPath}${file}>; rel=${ref};${cors} as=${asType}`)
  })
  return links
}

const getCspString = ({ cspScriptSrcHashSet, allowedSources, policies, isDev }) => {
  const joinedHashSet = Array.from(cspScriptSrcHashSet).join(' ')
  const baseCspStr = `script-src 'self'${isDev ? ` 'unsafe-eval'` : ''} ${joinedHashSet}`

  if (Array.isArray(allowedSources)) {
    return `${baseCspStr} ${allowedSources.join(' ')}`
  }

  const policyObjectAvailable = typeof policies === 'object' && policies !== null && !Array.isArray(policies)

  if (policyObjectAvailable) {
    const transformedPolicyObject = transformPolicyObject(policies, cspScriptSrcHashSet)

    return Object.entries(transformedPolicyObject).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ')
  }

  return baseCspStr
}

const transformPolicyObject = (policies, cspScriptSrcHashSet) => {
  const userHasDefinedScriptSrc = policies['script-src'] && Array.isArray(policies['script-src'])

  // Self is always needed for inline-scripts, so add it, no matter if the user specified script-src himself.

  const hashAndPolicySet = cspScriptSrcHashSet
  hashAndPolicySet.add(`'self'`)

  if (userHasDefinedScriptSrc) {
    new Set(policies['script-src']).forEach(src => hashAndPolicySet.add(src))
  }

  return { ...policies, 'script-src': Array.from(hashAndPolicySet) }
}
