package io.github.clockwerks77.eveops

import android.app.Application

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Refresh.schedule(this)
    }

    companion object {
        /** True while the dashboard is on screen: the open page keeps the widgets fed, so background refreshes stand down. */
        @Volatile
        var foreground = false
    }
}
