package xyz.freekoodo.reader;

import android.graphics.Bitmap;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.util.regex.Pattern;

public class MainActivity extends BridgeActivity {
    private static final String FORMATS = "epub|mobi|cbr|cbt|cbz|cb7|azw3|azw|txt|docx|md|fb2|html|htm|xml|xhtml|mhtml|href|pdf";
    private static final String READER_URL = "^https://localhost/(?:index[.]html)?#/(?:" + FORMATS + ")/[^/?#]+(?:[?][^#]*)?$";
    private static final Pattern READER_LOCATION = Pattern.compile(READER_URL);

    private static boolean isReader(String url) {
        return url != null && READER_LOCATION.matcher(url).matches();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) return;
        WebView webView = bridge.getWebView();
        OnBackPressedCallback callback = new OnBackPressedCallback(isReader(webView.getUrl())) {
            @Override
            public void handleOnBackPressed() {
                if (!isReader(webView.getUrl())) {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    return;
                }
                // Recheck the URL in the executing document after the async handoff.
                // Nothing from the book or URL is interpolated into the script.
                webView.evaluateJavascript("(function(){if(window.top!==window||!new RegExp(" +
                    "'" + READER_URL + "').test(window.location.href))return;" +
                    "if(window.dispatchEvent(new Event('koodo:android-reader-back',{cancelable:true})))" +
                    "window.__koodoReaderBackPending=true;})()", null);
            }
        };
        getOnBackPressedDispatcher().addCallback(this, callback);
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                callback.setEnabled(isReader(url));
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                super.doUpdateVisitedHistory(view, url, isReload);
                callback.setEnabled(isReader(url));
            }
        });
    }
}
