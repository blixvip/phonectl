// Runs on the phone via app_process (like scrcpy's server) and renders each app's real
// launcher icon — adaptive, themed, system apps included — to PNG files.
//   CLASSPATH=/data/local/tmp/phonectl-icondump.dex app_process / IconDump <outDir> <size> <pkg>...
// Build: tools/icondump/build.sh → tools/icondump/icondump.dex (checked in).
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.os.Looper;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;

public class IconDump {
    public static void main(String[] args) throws Exception {
        Looper.prepareMainLooper();
        // Same trick scrcpy uses: a bare ActivityThread gives us a system Context.
        Class<?> at = Class.forName("android.app.ActivityThread");
        Constructor<?> ctor = at.getDeclaredConstructor();
        ctor.setAccessible(true);
        Object thread = ctor.newInstance();
        Field cur = at.getDeclaredField("sCurrentActivityThread");
        cur.setAccessible(true);
        cur.set(null, thread);
        Field sys = at.getDeclaredField("mSystemThread");
        sys.setAccessible(true);
        sys.setBoolean(thread, true);
        // Samsung: getSystemContext() needs a ConfigurationController (scrcpy issue #4467).
        try {
            Class<?> cc = Class.forName("android.app.ConfigurationController");
            Constructor<?> ccCtor = cc.getDeclaredConstructor(Class.forName("android.app.ActivityThreadInternal"));
            ccCtor.setAccessible(true);
            Field ccField = at.getDeclaredField("mConfigurationController");
            ccField.setAccessible(true);
            ccField.set(thread, ccCtor.newInstance(thread));
        } catch (Throwable ignored) {
            // older Android: not needed
        }
        Context ctx = (Context) at.getDeclaredMethod("getSystemContext").invoke(thread);
        PackageManager pm = ctx.getPackageManager();

        File out = new File(args[0]);
        out.mkdirs();
        int size = Integer.parseInt(args[1]);
        for (int i = 2; i < args.length; i++) {
            String pkg = args[i];
            try {
                Drawable d = pm.getApplicationIcon(pkg);
                Bitmap b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
                d.setBounds(0, 0, size, size);
                d.draw(new Canvas(b));
                try (FileOutputStream o = new FileOutputStream(new File(out, pkg + ".png"))) {
                    b.compress(Bitmap.CompressFormat.PNG, 100, o);
                }
                System.out.println("ok " + pkg);
            } catch (Throwable t) {
                System.out.println("fail " + pkg + " " + t);
            }
        }
    }
}
