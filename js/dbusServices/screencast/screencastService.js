// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported ScreencastService */

imports.gi.versions.Gtk = '4.0';

const { Gio, GLib, Gst, Gtk } = imports.gi;

const { loadInterfaceXML, loadSubInterfaceXML } = imports.misc.fileUtils;
const { ServiceImplementation } = imports.dbusService;

const ScreencastIface = loadInterfaceXML('org.gnome.Shell.Screencast');

const IntrospectIface = loadInterfaceXML('org.gnome.Shell.Introspect');
const IntrospectProxy = Gio.DBusProxy.makeProxyWrapper(IntrospectIface);

const ScreenCastIface = loadSubInterfaceXML(
    'org.gnome.Mutter.ScreenCast', 'org.gnome.Mutter.ScreenCast');
const ScreenCastSessionIface = loadSubInterfaceXML(
    'org.gnome.Mutter.ScreenCast.Session', 'org.gnome.Mutter.ScreenCast');
const ScreenCastStreamIface = loadSubInterfaceXML(
    'org.gnome.Mutter.ScreenCast.Stream', 'org.gnome.Mutter.ScreenCast');
const ScreenCastProxy = Gio.DBusProxy.makeProxyWrapper(ScreenCastIface);
const ScreenCastSessionProxy = Gio.DBusProxy.makeProxyWrapper(ScreenCastSessionIface);
const ScreenCastStreamProxy = Gio.DBusProxy.makeProxyWrapper(ScreenCastStreamIface);

const DEFAULT_PIPELINE = 'videoconvert chroma-mode=GST_VIDEO_CHROMA_MODE_NONE dither=GST_VIDEO_DITHER_NONE matrix-mode=GST_VIDEO_MATRIX_MODE_OUTPUT_ONLY n-threads=%T ! queue ! vp8enc cpu-used=16 max-quantizer=17 deadline=1 keyframe-mode=disabled threads=%T static-threshold=1000 buffer-size=20000 ! queue ! webmmux';
const DEFAULT_FRAMERATE = 30;
const DEFAULT_DRAW_CURSOR = true;

const PipelineState = {
    INIT: "INIT",
    PLAYING: "PLAYING",
    FLUSHING: "FLUSHING",
    STOPPED: "STOPPED",
    ERROR: "ERROR",
};

const SessionState = {
    INIT: "INIT",
    ACTIVE: "ACTIVE",
    STOPPED: "STOPPED",
};

var Recorder = class {
    constructor(sessionPath, x, y, width, height, filePath, options,
        invocation,
        onErrorCallback) {
        this._startInvocation = invocation;
        this._dbusConnection = invocation.get_connection();
        this._onErrorCallback = onErrorCallback;
        this._stopInvocation = null;

        this._x = x;
        this._y = y;
        this._width = width;
        this._height = height;
        this._filePath = filePath;

        try {
            const dir = Gio.File.new_for_path(filePath).get_parent();
            dir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }

        this._pipelineString = DEFAULT_PIPELINE;
        this._framerate = DEFAULT_FRAMERATE;
        this._drawCursor = DEFAULT_DRAW_CURSOR;

        this._pipelineState = PipelineState.INIT;
        this._pipeline = null;

        this._applyOptions(options);
        this._watchSender(invocation.get_sender());

        this._sessionState = SessionState.INIT;
        this._initSession(sessionPath);
    }

    _applyOptions(options) {
        for (const option in options)
            options[option] = options[option].deep_unpack();

        if (options['framerate'] !== undefined)
            this._framerate = options['framerate'];
        if ('draw-cursor' in options)
            this._drawCursor = options['draw-cursor'];
    }

    _addRecentItem() {
        const file = Gio.File.new_for_path(this._filePath);
        Gtk.RecentManager.get_default().add_item(file.get_uri());
    }

    _watchSender(sender) {
        this._nameWatchId = this._dbusConnection.watch_name(
            sender,
            Gio.BusNameWatcherFlags.NONE,
            null,
            this._senderVanished.bind(this));
    }

    _unwatchSender() {
        if (this._nameWatchId !== 0) {
            this._dbusConnection.unwatch_name(this._nameWatchId);
            this._nameWatchId = 0;
        }
    }

    _bailOutOnError(error) {
        this._unwatchSender();

        if (this._onErrorCallback) {
            this._onErrorCallback(error);
            delete this._onErrorCallback;
        }

        if (this._requestStartPromise) {
            this._requestStartPromise.reject(error);
            delete this._requestStartPromise;
        }

        if (this._requestStopPromise) {
            this._requestStopPromise.reject(error);
            delete this._requestStopPromise;
        }
    }

    _handleFatalPipelineError(message) {
        this._pipelineState = PipelineState.ERROR;

        if (this._sessionState === SessionState.ACTIVE) {
            this._sessionProxy.StopSync();
            this._sessionState = SessionState.STOPPED;
        }

        this._bailOutOnError(new Error(`Fatal pipeline error: ${message}`));
    }

    _teardownPipeline() {
        if (!this._pipeline)
            return true;

        if (this._pipeline.set_state(Gst.State.NULL) !== Gst.StateChangeReturn.SUCCESS) {
            this._handleFatalPipelineError("Failed to tear down pipeline");
            this._pipeline = null;
            return false;
        }

        this._pipeline = null;
        return true;
    }

    _senderVanished() {
        // Throw away the pipeline if it's still running
        this._teardownPipeline();

        this._bailOutOnError(new Error(`Sender has vanished`));
    }

    _onSessionClosed() {
        this._sessionState = SessionState.STOPPED;

        if (this._pipelineState === PipelineState.STOPPED) {
            // All good, session got closed after we flushed the pipeline
        } else {
            // Throw away the pipeline if it's still running
            this._teardownPipeline();

            this._bailOutOnError(new Error(`Session closed unexpectedly with \
                pipeline still in state ${this._pipelineState}`));
        }
    }

    _initSession(sessionPath) {
        this._sessionProxy = new ScreenCastSessionProxy(Gio.DBus.session,
            'org.gnome.Mutter.ScreenCast',
            sessionPath);
        this._sessionProxy.connectSignal('Closed', this._onSessionClosed.bind(this));
    }

    _startPipeline(nodeId) {
        if (!this._ensurePipeline(nodeId))
            return;

        const bus = this._pipeline.get_bus();
        bus.add_watch(bus, this._onBusMessage.bind(this));

        this._pipeline.set_state(Gst.State.PLAYING);
        this._pipelineState = PipelineState.PLAYING;

        this._requestStartPromise.resolve();
        delete this._requestStartPromise;
    }

    startRecording() {
        return new Promise((resolve, reject) => {
            this._requestStartPromise = { resolve, reject };

            const [streamPath] = this._sessionProxy.RecordAreaSync(
                this._x, this._y,
                this._width, this._height,
                {
                    'is-recording': GLib.Variant.new('b', true),
                    'cursor-mode': GLib.Variant.new('u', this._drawCursor ? 1 : 0),
                });

            this._streamProxy = new ScreenCastStreamProxy(Gio.DBus.session,
                'org.gnome.ScreenCast.Stream',
                streamPath);

            this._streamProxy.connectSignal('PipeWireStreamAdded',
                (proxy, sender, params) => {
                    const [nodeId] = params;
                    this._startPipeline(nodeId);
                });
            this._sessionProxy.StartSync();
            this._sessionState = SessionState.ACTIVE;
        });
    }


    stopRecording() {
        return new Promise((resolve, reject) => {
            this._requestStopPromise = { resolve, reject };

            this._pipelineState = PipelineState.FLUSHING;
            this._pipeline.send_event(Gst.Event.new_eos());
        });
    }

    _onBusMessage(bus, message, _) {
        switch (message.type) {
        case Gst.MessageType.EOS:
            if (!this._teardownPipeline())
                break;

            switch (this._pipelineState) {
            case PipelineState.FLUSHING:
                this._addRecentItem();
                this._pipelineState = PipelineState.STOPPED;

                if (this._sessionState === SessionState.ACTIVE) {
                    this._sessionProxy.StopSync();
                    this._sessionState = SessionState.STOPPED;
                }

                this._unwatchSender();

                this._requestStopPromise.resolve();
                delete this._requestStopPromise;
                break;

            default:
                break;
            }

            break;

        default:
            break;
        }

        return true;
    }

    _substituteThreadCount(pipelineDescr) {
        const numProcessors = GLib.get_num_processors();
        const numThreads = Math.min(Math.max(1, numProcessors), 64);
        return pipelineDescr.replaceAll('%T', numThreads);
    }

    _ensurePipeline(nodeId) {
        const framerate = this._framerate;

        let fullPipeline = `
            pipewiresrc path=${nodeId}
                        do-timestamp=true
                        keepalive-time=1000
                        resend-last=true !
            video/x-raw,max-framerate=${framerate}/1 !
            ${this._pipelineString} !
            filesink location="${this._filePath}"`;
        fullPipeline = this._substituteThreadCount(fullPipeline);

        try {
            this._pipeline = Gst.parse_launch_full(fullPipeline,
                null,
                Gst.ParseFlags.FATAL_ERRORS);
        }  catch (e) {
            this._teardownPipeline();
            this._handleFatalPipelineError(`Failed to create pipeline: ${e.message}`);
        }
        return !!this._pipeline;
    }
};

var ScreencastService = class extends ServiceImplementation {
    constructor() {
        super(ScreencastIface, '/org/gnome/Shell/Screencast');

        Gst.init(null);
        Gtk.init();

        this._recorders = new Map();
        this._senders = new Map();

        this._lockdownSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.lockdown',
        });

        this._proxy = new ScreenCastProxy(Gio.DBus.session,
            'org.gnome.Mutter.ScreenCast',
            '/org/gnome/Mutter/ScreenCast');

        this._introspectProxy = new IntrospectProxy(Gio.DBus.session,
            'org.gnome.Shell.Introspect',
            '/org/gnome/Shell/Introspect');
    }

    _removeRecorder(sender) {
        if (!this._recorders.has(sender))
            return;

        this._recorders.delete(sender);
        if (this._recorders.size === 0)
            this.release();
    }

    _addRecorder(sender, recorder) {
        this._recorders.set(sender, recorder);
        if (this._recorders.size === 1)
            this.hold();
    }

    _getAbsolutePath(filename) {
        if (GLib.path_is_absolute(filename))
            return filename;

        let videoDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS);
        return GLib.build_filenamev([videoDir, filename]);
    }

    _generateFilePath(template) {
        let filename = '';
        let escape = false;

        [...template].forEach(c => {
            if (escape) {
                switch (c) {
                case '%':
                    filename += '%';
                    break;
                case 'd': {
                    const datetime = GLib.DateTime.new_now_local();
                    const datestr = datetime.format('%0x');
                    const datestrEscaped = datestr.replace(/\//g, '-');

                    filename += datestrEscaped;
                    break;
                }

                case 't': {
                    const datetime = GLib.DateTime.new_now_local();
                    const datestr = datetime.format('%0X');
                    const datestrEscaped = datestr.replace(/\//g, ':');

                    filename += datestrEscaped;
                    break;
                }

                default:
                    log(`Warning: Unknown escape ${c}`);
                }

                escape = false;
            } else if (c === '%') {
                escape = true;
            } else {
                filename += c;
            }
        });

        if (escape)
            filename += '%';

        return this._getAbsolutePath(filename);
    }

    async ScreencastAsync(params, invocation) {
        let returnValue = [false, ''];

        if (this._lockdownSettings.get_boolean('disable-save-to-disk')) {
            invocation.return_value(GLib.Variant.new('(bs)', returnValue));
            return;
        }

        const sender = invocation.get_sender();

        if (this._recorders.get(sender)) {
            invocation.return_value(GLib.Variant.new('(bs)', returnValue));
            return;
        }

        const [sessionPath] = this._proxy.CreateSessionSync({});

        const [fileTemplate, options] = params;
        const [screenWidth, screenHeight] = this._introspectProxy.ScreenSize;
        const filePath = this._generateFilePath(fileTemplate);

        let recorder;

        try {
            recorder = new Recorder(
                sessionPath,
                0, 0,
                screenWidth, screenHeight,
                filePath,
                options,
                invocation,
                error => {
                    logError(error, "Recorder error");
                    this._removeRecorder(sender);
                });
        } catch (error) {
            logError(error, "Failed to create recorder");
            invocation.return_value(GLib.Variant.new('(bs)', returnValue));
            return;
        }

        this._addRecorder(sender, recorder);

        try {
            await recorder.startRecording();
            returnValue = [true, filePath];
        } catch (error) {
            logError(error, "Failed to start recorder");
            this._removeRecorder(sender);
        } finally {
            invocation.return_value(GLib.Variant.new('(bs)', returnValue));
        }
    }

    async ScreencastAreaAsync(params, invocation) {
        let returnValue = [false, ''];

        if (this._lockdownSettings.get_boolean('disable-save-to-disk')) {
            invocation.return_value(GLib.Variant.new('(bs)', returnValue));
            return;
        }

        const sender = invocation.get_sender();

        if (this._recorders.get(sender)) {
            invocation.return_value(GLib.Variant.new('(bs)', returnValue));
            return;
        }

        const [sessionPath] = this._proxy.CreateSessionSync({});

        const [x, y, width, height, fileTemplate, options] = params;
        const filePath = this._generateFilePath(fileTemplate);

        let recorder;

        try {
            recorder = new Recorder(
                sessionPath,
                x, y,
                width, height,
                filePath,
                options,
                invocation,
                error => {
                    logError(error, "Recorder error");
                    this._removeRecorder(sender);
                });
        } catch (error) {
            logError(error, "Failed to create recorder");
            invocation.return_value(GLib.Variant.new('(bs)', returnValue));
            return;
        }

        this._addRecorder(sender, recorder);

        try {
            await recorder.startRecording();
            returnValue = [true, filePath];
        } catch (error) {
            logError(error, "Failed to start area recorder");
            this._removeRecorder(sender);
        } finally {
            invocation.return_value(GLib.Variant.new('(bs)', returnValue));
        }
    }

    async StopScreencastAsync(params, invocation) {
        const sender = invocation.get_sender();

        const recorder = this._recorders.get(sender);
        if (!recorder) {
            invocation.return_value(GLib.Variant.new('(b)', [false]));
            return;
        }

        try {
            await recorder.stopRecording();
        } catch (error) {
            logError(error, "Error while stopping recorder");
        } finally {
            this._removeRecorder(sender);
            invocation.return_value(GLib.Variant.new('(b)', [true]));
        }
    }
};
