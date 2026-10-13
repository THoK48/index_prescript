package com.directive.terminal;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Stores the current directive for the Android home-screen widget. */
@CapacitorPlugin(name = "DirectiveWidget")
public class DirectiveWidgetPlugin extends Plugin {
    public static final String PREFERENCES_NAME = "directive_widget";

    /** Persists widget text and immediately refreshes every placed widget instance. */
    @PluginMethod
    public void sync(PluginCall call) {
        SharedPreferences preferences = getContext().getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
        preferences.edit()
            .putString("recipient", call.getString("recipient", "사용자"))
            .putString("trigger", call.getString("trigger", "현재 활성 지령이 없습니다."))
            .putString("action", call.getString("action", "앱을 열어 다음 지령을 발행하세요."))
            .putString("deadline", call.getString("deadline", ""))
            .apply();
        DirectiveWidgetProvider.updateAllWidgets(getContext());
        call.resolve(new JSObject());
    }
}
