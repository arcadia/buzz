package xyz.block.buzz.mobile

import android.content.Context
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject

/** Reads the notice resource generated from this build variant's native dependencies. */
internal class NativeLicensesPlugin(context: Context, messenger: BinaryMessenger) {
    private val channel = MethodChannel(messenger, "buzz/native_licenses")

    init {
        channel.setMethodCallHandler { call, result ->
            if (call.method != "load") {
                result.notImplemented()
            } else {
                try {
                    // A direct resource reference also protects the notices from resource shrinking.
                    val document = context.resources.openRawResource(R.raw.aboutlibraries)
                        .bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
                    val licenses = document.getJSONObject("licenses")
                    val libraries = document.getJSONArray("libraries")
                    require(libraries.length() > 0) { "Native dependency notices are empty" }
                    val entries = (0 until libraries.length()).map { index ->
                        val library = libraries.getJSONObject(index)
                        val identity = library.getString("uniqueId")
                        val version = library.getString("artifactVersion")
                        val licenseIds = library.getJSONArray("licenses")
                        require(licenseIds.length() > 0) { "Missing notice for $identity" }
                        val text = (0 until licenseIds.length()).joinToString("\n\n") { position ->
                            val license = licenses.getJSONObject(licenseIds.getString(position))
                            val content = license.optString("content")
                            val url = license.optString("url")
                            require(content.isNotBlank() || url.isNotBlank()) {
                                "Empty notice for $identity"
                            }
                            // Proprietary SDK terms (e.g. ML Kit) publish a URL, not notice text.
                            content.ifBlank { "${license.optString("name")}\n$url" }
                        }
                        mapOf("name" to "$identity:$version (Android)", "text" to text)
                    }
                    result.success(entries)
                } catch (error: Exception) {
                    result.error("native_notices_unavailable", error.message, null)
                }
            }
        }
    }

    fun dispose() {
        channel.setMethodCallHandler(null)
    }
}
