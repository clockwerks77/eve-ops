package io.github.clockwerks77.eveops

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** The pieces of the EVE sign-in that need no Android classes, so they can be tested on any JVM. */
object Pkce {
    private val random = SecureRandom()
    private fun b64(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun random(bytes: Int): String = b64(ByteArray(bytes).also { random.nextBytes(it) })

    /** The S256 challenge for a verifier (RFC 7636). */
    fun challenge(verifier: String): String =
        b64(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
}

/** One signed-in character: the long-lived refresh token and the current short-lived access token. */
data class Session(
    val refresh: String,
    val access: String,
    val exp: Long,
    val id: Long,
    val name: String,
    val scopes: List<String>,
) {
    fun toJson(): String = JSONObject()
        .put("refresh", refresh).put("access", access).put("exp", exp)
        .put("id", id).put("name", name).put("scopes", JSONArray(scopes))
        .toString()

    companion object {
        fun fromJson(text: String): Session? = try {
            val o = JSONObject(text)
            val scp = o.optJSONArray("scopes")
            Session(
                refresh = o.getString("refresh"),
                access = o.getString("access"),
                exp = o.getLong("exp"),
                id = o.getLong("id"),
                name = o.optString("name"),
                scopes = if (scp == null) emptyList() else (0 until scp.length()).map { scp.getString(it) },
            )
        } catch (e: Exception) {
            null
        }

        /**
         * Reads EVE's answer from the token endpoint. Who the character is comes from the access token's own claims.
         * EVE may or may not send a new refresh token when renewing; without one the previous token stays in use.
         */
        fun fromAnswer(answer: JSONObject, now: Long, previousRefresh: String? = null): Session {
            val access = answer.getString("access_token")
            val parts = access.split(".")
            require(parts.size >= 2) { "EVE sent an access token this app cannot read." }
            val claims = JSONObject(String(Base64.getUrlDecoder().decode(parts[1]), Charsets.UTF_8))
            val scopes = when (val scp = claims.opt("scp")) {
                is JSONArray -> (0 until scp.length()).map { scp.getString(it) }
                is String -> listOf(scp)
                else -> emptyList()
            }
            val refresh = answer.optString("refresh_token").ifEmpty { previousRefresh ?: "" }
            require(refresh.isNotEmpty()) { "EVE sent no refresh token." }
            return Session(
                refresh = refresh,
                access = access,
                exp = now + (answer.optLong("expires_in", 1200) - 60) * 1000,
                id = claims.getString("sub").substringAfterLast(':').toLong(),
                name = claims.optString("name"),
                scopes = scopes,
            )
        }
    }
}
