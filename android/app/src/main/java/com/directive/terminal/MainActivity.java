package com.directive.terminal;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/** Hosts the web application and registers directive and calendar home-widget bridges. */
public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(DirectiveWidgetPlugin.class);
        registerPlugin(CalendarWidgetPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
