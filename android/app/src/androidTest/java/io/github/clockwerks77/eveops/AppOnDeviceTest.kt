package io.github.clockwerks77.eveops

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters

/**
 * Runs on an emulator against the live page's sample data (#demo), so no EVE sign-in is involved.
 * Screenshots land in /sdcard/Download/eveops for the workflow to collect.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class AppOnDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val ctx: Context = instrumentation.targetContext
    private val device: UiDevice = UiDevice.getInstance(instrumentation)

    private fun shot(name: String) {
        device.executeShellCommand("mkdir -p /sdcard/Download/eveops")
        device.executeShellCommand("screencap -p /sdcard/Download/eveops/$name.png")
    }

    private fun waitFor(seconds: Int, what: () -> Boolean): Boolean {
        val until = System.currentTimeMillis() + seconds * 1000L
        while (System.currentTimeMillis() < until) {
            if (what()) return true
            Thread.sleep(500)
        }
        return what()
    }

    private fun start(intent: Intent) {
        ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
    }

    private fun pending(): String? = ctx.getSharedPreferences("auth", Context.MODE_PRIVATE).getString("pending", null)

    @Test
    fun a_backgroundRefreshFillsTheWidgets() {
        Auth.signOut(ctx, Config.TRADER)
        Auth.signOut(ctx, Config.SCOUT)
        Snapshots.clear(ctx)
        // exactly what the half-hourly refresh does, pointed at the page's sample data
        val ok = runBlocking { withContext(Dispatchers.Main) { Headless(ctx).run(Config.PAGE + "#demo", 90_000) } }
        assertTrue("the page handed over a complete summary while off screen", ok)
        val snap = Snapshots.load(ctx)
        assertNotNull(snap)
        assertTrue(snap!!.optBoolean("sample"))
        assertEquals(10, snap.getJSONObject("orders").getInt("change"))
        assertEquals("J111613", snap.getJSONObject("wh").getString("system"))
        assertTrue(snap.getJSONObject("scout").getJSONObject("loot").getDouble("list") > 0)

        // a phone's 4-by-2 space, the smallest space, a tall one, and a wide one as on a tablet or an unfolded phone
        for ((name, width, height) in listOf(Triple("phone", 0, 200), Triple("small", 0, 120), Triple("tall", 0, 300), Triple("narrow", 300, 190))) {
            start(Intent(ctx, PreviewActivity::class.java).putExtra("width", width).putExtra("height", height))
            assertTrue("widgets drawn, $name", device.wait(Until.hasObject(By.text("Sample Trader (sample data)")), 15_000))
            Thread.sleep(1200)
            shot("widgets-$name")
        }
        start(Intent(ctx, PreviewActivity::class.java).putExtra("width", 640).putExtra("height", 290).putExtra("landscape", true))
        assertTrue("widgets drawn, wide", device.wait(Until.hasObject(By.text("Sample Trader (sample data)")), 20_000))
        Thread.sleep(2500)
        shot("widgets-wide")
        device.pressHome()
        Thread.sleep(1500)
    }

    @Test
    fun b_dashboardRunsInsideTheApp() {
        Snapshots.clear(ctx)
        start(Intent(Intent.ACTION_VIEW, Uri.parse("eveops://open?view=demo"), ctx, MainActivity::class.java))
        // the open page hands its summary to the app through the same link the widgets rely on
        assertTrue("the page in the app handed over a summary", waitFor(60) { Snapshots.load(ctx) != null })
        Thread.sleep(2500)
        shot("app-trading")
        start(Intent(Intent.ACTION_VIEW, Uri.parse("eveops://open?view=demo"), ctx, MainActivity::class.java))
        device.pressHome()
    }

    @Test
    fun c_signInOpensTheBrowserAndComesBack() {
        Auth.signOut(ctx, Config.TRADER)
        Snapshots.clear(ctx)
        start(Intent(ctx, MainActivity::class.java))
        val button = device.wait(Until.findObject(By.text("Log in with EVE")), 45_000)
        shot("app-door")
        assertNotNull("the sign-in screen shows", button)
        assertTrue("the page knows it is inside the app", device.hasObject(By.textContains("kept in this app only")))
        assertNull(pending())

        button.click()
        assertTrue("the app started a sign-in", waitFor(15) { pending() != null })
        assertTrue("a browser came to the front", waitFor(20) { device.currentPackageName != ctx.packageName })
        Thread.sleep(4000)
        shot("signin-browser")
        val state = JSONObject(pending()!!).getString("state")
        assertTrue(state.startsWith("app.trader."))

        // what the browser does after EVE approves, here with a code EVE will refuse
        start(Intent(Intent.ACTION_VIEW, Uri.parse("eveops://auth?code=not-a-real-code&state=$state")))
        assertTrue("the app came back to the front", device.wait(Until.hasObject(By.pkg(ctx.packageName)), 20_000))
        assertTrue("the one-time sign-in state was used up", waitFor(30) { pending() == null })
        assertNull("a refused code signs nobody in", Auth.session(ctx, Config.TRADER))
        assertNotNull("back at the sign-in screen", device.wait(Until.findObject(By.text("Log in with EVE")), 45_000))
        shot("after-refused-code")
        assertNotEquals("", state)
    }
}
