import { EventEmitter } from "eventemitter3";
import { MediaDevicesEvents, PermissionStatus, MediaDevices, NO_DEVICE_ID } from "./media-devices-utils";
import { detectOS, detect } from "detect-browser";
import { isIOS as detectIOS } from "./is-mobile";

const isMobile = AFRAME.utils.device.isMobile();
const isIOS = detectIOS();

// This is a list of regexes that match the microphone labels of HMDs.
//
// If entering VR mode, and if any of these regexes match an audio device,
// the user will be prevented from entering VR until one of those devices is
// selected as the microphone.
//
// Note that this doesn't have to be exhaustive: if no devices match any regex
// then we rely upon the user to select the proper mic.
const HMD_MIC_REGEXES = [/\Wvive\W/i, /\Wrift\W/i];

const audioOutputSelectEnabled = "sinkId" in HTMLMediaElement.prototype;

// Subsequest calls to getUserMedia throw an exception and return a muted track so we disable mic selection for the moment.
// Safari 15+
const detectedOS = detectOS(navigator.userAgent);
const browser = detect();
const audioInputSelectEnabled = !(["iOS", "Mac OS"].includes(detectedOS) && ["safari", "ios"].includes(browser.name));

// vegamix: the errors getUserMedia raises when the person said no, as opposed to
// when the device is simply not available right now. Only these mean "denied" -
// see _startMicShare.
const MIC_DENIAL_ERRORS = ["NotAllowedError", "PermissionDeniedError", "SecurityError"];

// How long to keep trying to reopen a microphone that went away, in ms between
// attempts. Roughly a minute in total, which covers a short call taken in another
// application - the usual reason it disappears.
const MIC_RECOVERY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000];

// How often to look at whether the microphone is still working. Reading a few
// properties, so it can be often enough that nobody gets to finish a sentence into
// a dead microphone.
const MIC_HEALTH_CHECK_MS = 5000;

// A track reports muted for a moment when the operating system takes the device
// briefly - a notification sound on some drivers is enough. Only a mute that
// outlasts this is treated as a microphone that stopped delivering.
const MIC_MUTED_GRACE_MS = 15000;

// How often the watchdog may try to publish a microphone that is alive but reaching
// nobody. Slower than the check itself: republishing is cheap only when it works.
const MIC_REPUBLISH_INTERVAL_MS = 15000;

export default class MediaDevicesManager extends EventEmitter {
  constructor(scene, store, audioSystem) {
    super();

    this._scene = scene;
    this._store = store;
    this._micDevices = [];
    this._videoDevices = [];
    this._outputDevices = [];
    this._deviceId = null;
    this._audioTrack = null;
    this._lastMicError = null;
    // Whether a microphone is meant to be open at all. Set by a share that worked,
    // cleared by one the person ended, so the watchdog below never reopens a device
    // for someone who deliberately closed it.
    this._micShareWanted = false;
    this._micRecoveryInFlight = false;
    this._micMutedSince = null;
    this._lastRepublishAt = 0;
    this.audioSystem = audioSystem;
    this._mediaStream = audioSystem.outboundStream;
    this._permissionsStatus = {
      [MediaDevices.MICROPHONE]: PermissionStatus.PROMPT,
      [MediaDevices.SPEAKERS]: PermissionStatus.PROMPT,
      [MediaDevices.CAMERA]: PermissionStatus.PROMPT,
      [MediaDevices.SCREEN]: PermissionStatus.PROMPT
    };

    this.onDeviceChange = this.onDeviceChange.bind(this);
    navigator.mediaDevices.addEventListener("devicechange", this.onDeviceChange);
    this.onPermissionsUpdated = this.onPermissionsUpdated.bind(this);
    APP.hubChannel.addEventListener("permissions_updated", this.onPermissionsUpdated);

    // vegamix: a microphone that stops working announces it to nobody. The person
    // keeps talking, the level bar sits still, and the first sign is somebody saying
    // they cannot hear you - by which point the sentence is gone. So look.
    setInterval(() => this._checkMicHealth(), MIC_HEALTH_CHECK_MS);
    // Two moments worth checking at once rather than waiting for the next tick: a
    // device appearing or disappearing, and coming back to the tab. Both are when a
    // microphone typically returns after whatever borrowed it is finished.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this._checkMicHealth();
    });
  }

  static get isAudioOutputSelectEnabled() {
    return audioOutputSelectEnabled;
  }

  static get isAudioInputSelectEnabled() {
    return audioInputSelectEnabled;
  }

  get deviceId() {
    return this._deviceId;
  }

  set deviceId(deviceId) {
    this._deviceId = deviceId;
  }

  get audioTrack() {
    return this._audioTrack;
  }

  set audioTrack(audioTrack) {
    this._audioTrack = audioTrack;
  }

  get defaultInputDeviceId() {
    return this._micDevices.length > 0 ? this._micDevices[0].value : NO_DEVICE_ID;
  }

  get defaultOutputDeviceId() {
    return this._outputDevices.length > 0 ? this._outputDevices[0].value : NO_DEVICE_ID;
  }

  get defaultVideoDeviceId() {
    return this._videoDevices.length > 0 ? this._videoDevices[0].value : NO_DEVICE_ID;
  }

  get micDevicesOptions() {
    return this._micDevices.length > 0 ? this._micDevices : [{ value: NO_DEVICE_ID, label: "None" }];
  }

  get videoDevicesOptions() {
    return this._videoDevices.length > 0 ? this._videoDevices : [{ value: NO_DEVICE_ID, label: "None" }];
  }

  get outputDevicesOptions() {
    return this._outputDevices.length > 0 ? this._outputDevices : [{ value: NO_DEVICE_ID, label: "None" }];
  }

  get mediaStream() {
    return this._mediaStream;
  }

  set mediaStream(mediaStream) {
    this._mediaStream = mediaStream;
  }

  get selectedMicLabel() {
    return this.micLabelForAudioTrack(this.audioTrack);
  }

  get selectedMicDeviceId() {
    return MediaDevicesManager.isAudioInputSelectEnabled &&
      this._permissionsStatus[MediaDevices.MICROPHONE] !== PermissionStatus.GRANTED
      ? NO_DEVICE_ID
      : this.deviceIdForMicDeviceLabel(this.selectedMicLabel);
  }

  get selectedSpeakersDeviceId() {
    const { preferredSpeakers } = this._store.state.preferences;
    const exists = this._outputDevices.some(device => {
      return device.value === preferredSpeakers;
    });
    return exists ? preferredSpeakers : this.defaultOutputDeviceId;
  }

  get isMicShared() {
    return this.audioTrack !== null && this.getPermissionsStatus(MediaDevices.MICROPHONE) === PermissionStatus.GRANTED;
  }

  get isVideoShared() {
    return this._mediaStream?.getVideoTracks().length > 0;
  }

  // vegamix: both of these had a block body with no return, so some() saw undefined
  // every time and they were permanently false. The share popover reads isWebcamShared
  // to decide which source is live, so a shared camera was being reported as a shared
  // screen.
  get isWebcamShared() {
    return this._mediaStream.getVideoTracks().some(track => track["_hubs_contentHint"] === MediaDevices.CAMERA);
  }

  get isScreenShared() {
    return this._mediaStream.getVideoTracks().some(track => track["_hubs_contentHint"] === MediaDevices.SCREEN);
  }

  set micEnabled(enabled) {
    APP.dialog.enableMicrophone(enabled);
  }

  get isMicEnabled() {
    return APP.dialog.isMicEnabled;
  }

  toggleMic() {
    APP.dialog.toggleMicrophone();
  }

  getPermissionsStatus(type) {
    return this._permissionsStatus[type];
  }

  onPermissionsUpdated = () => {
    if (!APP.hubChannel.can("voice_chat")) {
      APP.dialog.enableMicrophone(false);
    }
  };

  onDeviceChange = () => {
    this.fetchMediaDevices().then(() => {
      this.changeAudioOutput(this.selectedSpeakersDeviceId);
      this.emit(MediaDevicesEvents.DEVICE_CHANGE, null);
      // A device list that just changed is the most likely moment for a microphone to
      // have come back, so do not wait for the next tick of the watchdog.
      this._checkMicHealth();
    });
  };

  updatePermissions() {
    const micStatus = this._micDevices.length === 0 ? PermissionStatus.PROMPT : PermissionStatus.GRANTED;
    this._permissionsStatus[MediaDevices.MICROPHONE] = micStatus;
    this.emit(MediaDevicesEvents.PERMISSIONS_STATUS_CHANGED, {
      mediaDevice: MediaDevices.MICROPHONE,
      status: micStatus
    });
    const videoStatus = this._videoDevices.length === 0 ? PermissionStatus.PROMPT : PermissionStatus.GRANTED;
    this._permissionsStatus[MediaDevices.CAMERA] = videoStatus;
    this.emit(MediaDevicesEvents.PERMISSIONS_STATUS_CHANGED, {
      mediaDevice: MediaDevices.CAMERA,
      status: videoStatus
    });
    const speakersStatus = this._micDevices.length === 0 ? PermissionStatus.PROMPT : PermissionStatus.GRANTED;
    this._permissionsStatus[MediaDevices.SPEAKERS] = speakersStatus;
    this.emit(MediaDevicesEvents.PERMISSIONS_STATUS_CHANGED, {
      mediaDevice: MediaDevices.SPEAKERS,
      status: speakersStatus
    });
  }

  async fetchMediaDevices() {
    console.log("Fetching media devices");
    return new Promise(resolve => {
      navigator.mediaDevices.enumerateDevices().then(mediaDevices => {
        mediaDevices = mediaDevices.filter(d => d.label !== "");
        this._micDevices = mediaDevices
          .filter(d => d.deviceId !== "default" && d.kind === "audioinput")
          .map(d => ({ value: d.deviceId, label: d.label || `Mic Device (${d.deviceId.substring(0, 9)})` }));
        this._videoDevices = mediaDevices
          .filter(d => d.deviceId !== "default" && d.kind === "videoinput")
          .map(d => ({ value: d.deviceId, label: d.label || `Camera Device (${d.deviceId.substring(0, 9)})` }));
        if (MediaDevicesManager.isAudioOutputSelectEnabled) {
          this._outputDevices = mediaDevices
            .filter(d => d.deviceId !== "default" && d.kind === "audiooutput")
            .map(d => ({ value: d.deviceId, label: d.label || `Audio Output (${d.deviceId.substring(0, 9)})` }));
        }
        this.updatePermissions();
        resolve();
      });
    });
  }

  changeAudioOutput(deviceId) {
    this._store.update({ preferences: { preferredSpeakers: deviceId } });
  }

  async startMicShare({ deviceId, unmute, updatePrefs = true }) {
    if (this.isMicShared && this.selectedMicDeviceId === deviceId) return;
    console.log("Starting microphone sharing");

    if (!deviceId) {
      const { preferredMic } = this._store.state.preferences;
      deviceId = preferredMic !== NO_DEVICE_ID ? preferredMic : undefined;
    }
    let constraints = { audio: {} };
    if (deviceId) {
      constraints = { audio: { deviceId: { ideal: [deviceId] } } };
    }

    const result = await this._startMicShare(constraints);

    await this.fetchMediaDevices();

    // we should definitely have an audioTrack at this point unless they denied mic access
    if (this.audioTrack) {
      const micDeviceId = this.deviceIdForMicDeviceLabel(this.micLabelForAudioTrack(this.audioTrack));
      if (micDeviceId) {
        if (updatePrefs) {
          this._store.update({
            preferences: {
              preferredMic: micDeviceId,
              preferredSpeakers: this.selectedSpeakersDeviceId
            }
          });
        }
        console.log(`Selected input device: ${this.micLabelForDeviceId(micDeviceId)}`);
      }
    } else {
      console.log("No available audio tracks");
    }

    await APP.dialog.setLocalMediaStream(this._mediaStream);

    if (unmute) {
      APP.dialog.enableMicrophone(true);
    }

    if (result) {
      // From here on there is a microphone worth keeping alive - see _checkMicHealth.
      this._micShareWanted = true;
      this._permissionsStatus[MediaDevices.MICROPHONE] = PermissionStatus.GRANTED;
      this._scene.emit(MediaDevicesEvents.MIC_SHARE_STARTED);
      this.emit(MediaDevicesEvents.PERMISSIONS_STATUS_CHANGED, {
        mediaDevice: MediaDevices.MICROPHONE,
        status: PermissionStatus.GRANTED
      });
    } else {
      // vegamix: a device that is busy is not a device that was refused. A microphone
      // another application is holding comes back as NotReadableError, and calling that
      // a denial latched the status here to DENIED, which makes selectedMicDeviceId
      // report "no device" - so the list of microphones lost its selection and picking
      // another one looked like it did nothing. Only a real refusal changes the status.
      const denied = MIC_DENIAL_ERRORS.includes(this._lastMicError?.name);
      const status = denied ? PermissionStatus.DENIED : this._permissionsStatus[MediaDevices.MICROPHONE];

      this._permissionsStatus[MediaDevices.MICROPHONE] = status;
      this._scene.emit(MediaDevicesEvents.MIC_SHARE_ENDED);
      this.emit(MediaDevicesEvents.PERMISSIONS_STATUS_CHANGED, {
        mediaDevice: MediaDevices.MICROPHONE,
        status
      });
    }

    return result;
  }

  async _startMicShare(constraints = { audio: {} }) {
    if (this.audioTrack) {
      this.audioTrack.stop();
    }

    constraints.audio.echoCancellation = !this._store.state.preferences.disableEchoCancellation;
    constraints.audio.noiseSuppression = !this._store.state.preferences.disableNoiseSuppression;
    constraints.audio.autoGainControl = !this._store.state.preferences.disableAutoGainControl;

    try {
      console.log("Adding microphone media stream");
      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.audioSystem.addStreamToOutboundAudio("microphone", newStream);
      this.audioTrack = newStream.getAudioTracks()[0];
      this._lastMicError = null;
      this.audioTrack.addEventListener("ended", async () => {
        this._scene.emit(MediaDevicesEvents.MIC_SHARE_ENDED);
        // vegamix: was a single attempt, which is the one thing that cannot work.
        // The usual reason a microphone ends is that another application took it,
        // and it is still holding it when we ask for it back.
        this._recoverMicShare();
      });

      if (/Oculus/.test(navigator.userAgent)) {
        // HACK Oculus Browser 6 seems to randomly end the microphone audio stream. This re-creates it.
        // Note the ended event will only fire if some external event ends the stream, not if we call stop().
        const recreateAudioStream = async () => {
          console.warn(
            "Oculus Browser 6 bug hit: Audio stream track ended without calling stop. Recreating audio stream."
          );

          const newStream = await navigator.mediaDevices.getUserMedia(constraints);
          this.audioTrack = newStream.getAudioTracks()[0];

          this.audioSystem.addStreamToOutboundAudio("microphone", newStream);

          this._scene.emit(MediaDevicesEvents.MIC_SHARE_STARTED);

          this.audioTrack.addEventListener("ended", recreateAudioStream, { once: true });
        };

        this.audioTrack.addEventListener("ended", recreateAudioStream, { once: true });
      }

      return true;
    } catch (e) {
      // Error fetching audio track, most likely a permission denial.
      console.error("Error during getUserMedia: ", e);
      this._lastMicError = e;
      this.audioTrack = null;
      return false;
    }
  }

  // vegamix: a microphone can go away without anyone touching Hubs - another
  // application opens it, a headset is unplugged, the OS moves the default device.
  // Asking for it back once fails while whatever took it still has it, and until
  // this existed that was the end of the microphone until the page was reloaded.
  // So keep asking for about a minute, which outlasts a short call taken elsewhere.
  async _recoverMicShare() {
    // One at a time. The watchdog can call this every few seconds, and restarting the
    // backoff on each call would turn a patient retry into a hammering.
    if (this._micRecoveryInFlight) return;
    this._micRecoveryInFlight = true;

    // Whether the person was being heard before it went, so they are put back the way
    // they were rather than silently unmuted. isMicEnabled alone would be wrong here:
    // it reads the producer, and the producer is often exactly what was lost, which
    // would bring the microphone back muted for someone who never muted it.
    const unmute = this.isMicEnabled || !!APP.dialog?.micShouldBeEnabled;

    try {
      for (const delay of MIC_RECOVERY_DELAYS_MS) {
        await new Promise(resolve => setTimeout(resolve, delay));

        // The person picking a device by hand, or pressing unmute, got there first.
        if (this.isMicShared) return;

        if (await this.startMicShare({ unmute })) {
          this._micMutedSince = null;
          console.log("Microphone recovered");
          return;
        }

        // A refusal will not turn into a yes by asking again.
        if (MIC_DENIAL_ERRORS.includes(this._lastMicError?.name)) {
          console.warn("Giving up on the microphone: access was denied");
          return;
        }
      }

      console.warn("Could not reopen the microphone; it is still held by something else");
    } finally {
      this._micRecoveryInFlight = false;
    }
  }

  // vegamix: the health check behind the watchdog. Two different things can be wrong
  // and they need different repairs: the microphone itself can be gone, or it can be
  // perfectly alive while nothing is carrying it to anyone.
  _checkMicHealth() {
    // Nobody asked for a microphone, or one is already being fetched.
    if (!this._micShareWanted || this._micRecoveryInFlight) return;

    const track = this.audioTrack;

    if (!track || track.readyState !== "live") {
      console.warn("Microphone is gone; trying to open it again");
      this._recoverMicShare();
      return;
    }

    // A live track that reports muted is the device saying it is not delivering -
    // unplugged, taken by the system, put to sleep. It does not end, so nothing else
    // notices. Brief mutes are normal, a lasting one is not.
    if (track.muted) {
      this._micMutedSince = this._micMutedSince || performance.now();
      if (performance.now() - this._micMutedSince > MIC_MUTED_GRACE_MS) {
        console.warn("Microphone has been delivering nothing; trying to open it again");
        this._micMutedSince = null;
        this._recoverMicShare();
      }
      return;
    }
    this._micMutedSince = null;

    // The microphone is fine. Is anyone receiving it? A producer can be lost with its
    // transport while the device itself never notices, which is the shape of failure
    // where the level bar moves and yet nobody hears a thing.
    if (APP.dialog?.micShouldBeEnabled && !APP.dialog.isMicEnabled) {
      // Paced, because if publishing cannot succeed - no transport to publish onto,
      // say - this would otherwise retry and complain every few seconds forever.
      const now = performance.now();
      if (!this._lastRepublishAt || now - this._lastRepublishAt > MIC_REPUBLISH_INTERVAL_MS) {
        this._lastRepublishAt = now;
        console.warn("Microphone is live but not being sent; publishing it again");
        APP.dialog.enableMicrophone(true);
      }
    }
  }

  async stopMicShare() {
    // Deliberate: the watchdog must not undo it.
    this._micShareWanted = false;
    this._micMutedSince = null;
    this.audioSystem.removeStreamFromOutboundAudio("microphone");

    this.audioTrack?.stop();
    this.audioTrack = null;

    await APP.dialog.setLocalMediaStream(this._mediaStream);
    APP.dialog.enableMicrophone(false);
  }

  async startVideoShare({ isDisplayMedia, target, success, error }) {
    let newStream;
    let videoTrackAdded = false;

    try {
      if (isDisplayMedia) {
        newStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            // Capture at native resolution — the old 720p cap made shared text
            // unreadable. "ideal" keeps other-aspect windows/monitors working.
            width: { ideal: screen.width },
            height: { ideal: screen.height },
            frameRate: 30
          },
          audio: {
            echoCancellation: window.APP.store.state.preferences.disableEchoCancellation === true ? false : true,
            noiseSuppression: window.APP.store.state.preferences.disableNoiseSuppression === true ? false : true,
            autoGainControl: window.APP.store.state.preferences.disableAutoGainControl === true ? false : true
          }
        });
      } else {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: isIOS ? { max: 1280 } : { max: 1280, ideal: 720 },
            frameRate: 30
          }
          //TODO: Capture audio from camera?
        });
      }

      const videoTracks = newStream ? newStream.getVideoTracks() : [];
      if (videoTracks.length > 0) {
        videoTrackAdded = true;

        newStream.getVideoTracks().forEach(track => {
          if (isDisplayMedia) {
            try {
              // Writable in modern Chrome/Firefox: makes the encoder favor
              // sharpness over motion smoothness — critical for shared text.
              track.contentHint = "detail";
            } catch (e) {
              // Older browsers: hint stays default, capture resolution still helps.
            }
          }
          track["_hubs_contentHint"] = isDisplayMedia ? MediaDevices.SCREEN : MediaDevices.CAMERA;
          track.addEventListener("ended", async () => {
            this._scene.emit(MediaDevicesEvents.VIDEO_SHARE_ENDED);
          });
          this._mediaStream.addTrack(track);
        });

        if (newStream && newStream.getAudioTracks().length > 0) {
          this.audioSystem.addStreamToOutboundAudio("screenshare", newStream);
        }

        await APP.dialog.setLocalMediaStream(this._mediaStream);

        const mediaDevice = isDisplayMedia ? MediaDevices.SCREEN : MediaDevices.CAMERA;
        this._permissionsStatus[mediaDevice] = PermissionStatus.GRANTED;
        this._scene.emit(MediaDevicesEvents.VIDEO_SHARE_STARTED);
        this.emit(MediaDevicesEvents.PERMISSIONS_STATUS_CHANGED, { mediaDevice, status: PermissionStatus.GRANTED });
      }
    } catch (e) {
      error(e);
      const mediaDevice = isDisplayMedia ? MediaDevices.SCREEN : MediaDevices.CAMERA;
      this._permissionsStatus[mediaDevice] = PermissionStatus.DENIED;
      this._scene.emit(MediaDevicesEvents.VIDEO_SHARE_ENDED);
      this.emit(MediaDevicesEvents.PERMISSIONS_STATUS_CHANGED, { mediaDevice, status: PermissionStatus.DENIED });
      return;
    }

    success(isDisplayMedia, videoTrackAdded, target);
  }

  async stopVideoShare() {
    if (!this._mediaStream) return;

    for (const track of this._mediaStream.getVideoTracks()) {
      track.stop(); // Stop video track to remove the "Stop screen sharing" bar right away.
      this._mediaStream.removeTrack(track);
    }

    this.audioSystem.removeStreamFromOutboundAudio("screenshare");

    await APP.dialog.setLocalMediaStream(this._mediaStream);
  }

  async shouldShowHmdMicWarning() {
    if (isMobile || AFRAME.utils.device.isMobileVR()) return false;
    if (!this.state.enterInVR) return false;
    if (!this.hasHmdMicrophone()) return false;

    return !HMD_MIC_REGEXES.find(r => this.selectedMicLabel.match(r));
  }

  micLabelForAudioTrack(audioTrack) {
    const label = (audioTrack && audioTrack.label) || "";
    if (label.indexOf("Default - ") < 0) {
      return label;
    } else {
      return label.substring(10);
    }
  }

  deviceIdForMicDeviceLabel(label) {
    return this._micDevices.filter(d => d.label === label).map(d => d.value)[0] || this.defaultInputDeviceId;
  }

  deviceIdForSpeakersDeviceLabel(label) {
    return this._outputDevices.filter(d => d.label === label).map(d => d.value)[0] || this.defaultOutputDeviceId;
  }

  micLabelForDeviceId(deviceId) {
    return this._micDevices.filter(d => d.value === deviceId).map(d => d.label)[0];
  }

  speakersLabelForDeviceId(deviceId) {
    return this._outputDevices.filter(d => d.value === deviceId).map(d => d.label)[0];
  }

  hasHmdMicrophone() {
    return !!this.state._micDevices.find(d => HMD_MIC_REGEXES.find(r => d.label.match(r)));
  }

  videoDeviceIdForMicLabel(label) {
    return this._videoDevices.filter(d => d.label === label).map(d => d.value)[0];
  }

  videoLabelForDeviceId(deviceId) {
    return this._videoDevices.filter(d => d.value === deviceId).map(d => d.label)[0];
  }
}
