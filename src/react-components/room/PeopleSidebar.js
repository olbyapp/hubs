import React from "react";
import PropTypes from "prop-types";
import classNames from "classnames";
import { ToolTip } from "@mozilla/lilypad-ui";
import styles from "./PeopleSidebar.scss";
import { Sidebar } from "../sidebar/Sidebar";
import { CloseButton } from "../input/CloseButton";
import { IconButton } from "../input/IconButton";
import { ReactComponent as StarIcon } from "../icons/Star.svg";
import { AWAY_GLYPH } from "../../utils/status-icons";
import { ReactComponent as DesktopIcon } from "../icons/Desktop.svg";
import { ReactComponent as DiscordIcon } from "../icons/Discord.svg";
import { ReactComponent as PhoneIcon } from "../icons/Phone.svg";
import { ReactComponent as VRIcon } from "../icons/VR.svg";
import { ReactComponent as VolumeOffIcon } from "../icons/VolumeOff.svg";
import { ReactComponent as VolumeHighIcon } from "../icons/VolumeHigh.svg";
import { ReactComponent as VolumeMutedIcon } from "../icons/VolumeMuted.svg";
import { ReactComponent as HandRaisedIcon } from "../icons/HandRaised.svg";
import { ReactComponent as UserSoundOnIcon } from "../icons/UserSoundOn.svg";
import { ReactComponent as UserSoundOffIcon } from "../icons/UserSoundOff.svg";
import { ReactComponent as CallIcon } from "../icons/Call.svg";
import { List, ButtonListItem } from "../layout/List";
import { FormattedMessage, defineMessage, useIntl } from "react-intl";
import { PermissionNotification } from "./PermissionNotifications";
import { STATUS_DISPLAY_NAMES, STATUS_COLORS } from "../../utils/user-status";
import { ACHIEVEMENTS, achievementKeys } from "../../utils/achievements";

function StatusLabel({ status }) {
  const s = status && STATUS_DISPLAY_NAMES[status] ? status : "none";
  return (
    <span style={{ color: STATUS_COLORS[s], fontWeight: 600, whiteSpace: "nowrap" }}>{STATUS_DISPLAY_NAMES[s]}</span>
  );
}

StatusLabel.propTypes = {
  status: PropTypes.string
};

const toolTipDescription = defineMessage({
  id: "people-sidebar.muted-tooltip",
  defaultMessage: "User is {mutedState}"
});

const callDescription = defineMessage({
  id: "people-sidebar.call-tooltip",
  defaultMessage: "Call {name}"
});

const callRingingDescription = defineMessage({
  id: "people-sidebar.call-ringing-tooltip",
  defaultMessage: "Your last call is still ringing"
});

function getDeviceLabel(ctx, intl) {
  if (ctx) {
    if (ctx.hmd) {
      return intl.formatMessage({ id: "people-sidebar.device-label.vr", defaultMessage: "VR" });
    } else if (ctx.discord) {
      return intl.formatMessage({ id: "people-sidebar.device-label.discord", defaultMessage: "Discord Bot" });
    } else if (ctx.mobile) {
      return intl.formatMessage({ id: "people-sidebar.device-label.mobile", defaultMessage: "Mobile" });
    }
  }

  return intl.formatMessage({ id: "people-sidebar.device-label.desktop", defaultMessage: "Desktop" });
}

function getDeviceIconComponent(ctx) {
  if (ctx) {
    if (ctx.hmd) {
      return VRIcon;
    } else if (ctx.discord) {
      return DiscordIcon;
    } else if (ctx.mobile) {
      return PhoneIcon;
    }
  }

  return DesktopIcon;
}

function getVoiceLabel(micPresence, intl) {
  if (micPresence) {
    if (micPresence.talking) {
      return intl.formatMessage({ id: "people-sidebar.voice-label.talking", defaultMessage: "Talking" });
    } else if (micPresence.muted) {
      return intl.formatMessage({ id: "people-sidebar.voice-label.muted", defaultMessage: "Muted" });
    }
  }

  return intl.formatMessage({ id: "people-sidebar.voice-label.not-talking", defaultMessage: "Not Talking" });
}

function getVoiceIconComponent(micPresence) {
  if (micPresence) {
    if (micPresence.muted) {
      return VolumeMutedIcon;
    } else if (micPresence.talking) {
      return VolumeHighIcon;
    }
  }

  return VolumeOffIcon;
}

function getPresenceMessage(presence, intl) {
  switch (presence) {
    case "lobby":
      return intl.formatMessage({ id: "people-sidebar.presence.in-lobby", defaultMessage: "In Lobby" });
    case "room":
      return intl.formatMessage({ id: "people-sidebar.presence.in-room", defaultMessage: "In Room" });
    case "entering":
      return intl.formatMessage({ id: "people-sidebar.presence.entering", defaultMessage: "Entering Room" });
    default:
      return undefined;
  }
}

function getPersonName(person, intl) {
  const you = intl.formatMessage({
    id: "people-sidebar.person-name.you",
    defaultMessage: "You"
  });
  return person.isMe ? `${person.profile.displayName} (${you})` : person.profile.displayName;
}

// Weekly awards, as icons. The label used to sit here as text and pushed the
// status and presence off the end of the row on any name of normal length, so
// it moved into a tooltip: a row is a glance, and the glyph is the glance.
//
// A native title rather than the panel's ToolTip on purpose — this list
// scrolls, and a lilypad tooltip on a row halfway down it gets clipped by the
// scroll container, which is the same trap the call button fell into.
function AchievementBadges({ person }) {
  const keys = achievementKeys(person.profile && person.profile.achievement);
  if (!keys.length) return null;
  return (
    <span className={styles.achievements}>
      {keys.map(key => (
        <span
          key={key}
          className={styles.achievement}
          title={`${ACHIEVEMENTS[key].label} — ${ACHIEVEMENTS[key].blurb}`}
        >
          {ACHIEVEMENTS[key].emoji}
        </span>
      ))}
    </span>
  );
}

AchievementBadges.propTypes = {
  person: PropTypes.object.isRequired
};

export function PeopleSidebar({
  people,
  onSelectPerson,
  onCallPerson,
  callDisabled,
  onClose,
  showMuteAll,
  onMuteAll,
  canVoiceChat,
  voiceChatEnabled,
  isMod
}) {
  const intl = useIntl();
  const me = people.find(person => !!person.isMe);
  const filteredPeople = people
    .filter(person => !person.isMe)
    .sort(a => {
      return a.hand_raised ? -1 : 1;
    });
  me && filteredPeople.unshift(me);
  // fallback if AFRAME's injected window globals aren't present (eg testing environments)
  const store = window.APP?.store || { _preferences: { avatarVoiceLevels: {} } };

  function getToolTipDescription(isMuted) {
    return intl.formatMessage(toolTipDescription, { mutedState: isMuted ? "muted" : "not muted" });
  }

  return (
    <Sidebar
      title={
        <FormattedMessage
          id="people-sidebar.title"
          defaultMessage="People ({numPeople})"
          values={{ numPeople: people.length }}
        />
      }
      beforeTitle={<CloseButton onClick={onClose} />}
      afterTitle={
        showMuteAll ? (
          <IconButton onClick={onMuteAll}>
            <FormattedMessage id="people-sidebar.mute-all-button" defaultMessage="Mute All" />
          </IconButton>
        ) : undefined
      }
    >
      {!canVoiceChat && <PermissionNotification permission={"voice_chat"} />}
      {!voiceChatEnabled && isMod && <PermissionNotification permission={"voice_chat"} isMod={true} />}
      <List>
        {!!people.length &&
          filteredPeople.map(person => {
            const DeviceIcon = getDeviceIconComponent(person.context);
            const VoiceIcon = getVoiceIconComponent(person.micPresence);

            return (
              <ButtonListItem
                className={styles.person}
                key={person.id}
                type="button"
                onClick={e => onSelectPerson(person, e)}
              >
                {person.hand_raised && <HandRaisedIcon />}
                {<DeviceIcon title={getDeviceLabel(person.context, intl)} />}
                {!person.context.discord && VoiceIcon && <VoiceIcon title={getVoiceLabel(person.micPresence, intl)} />}
                {!person.isMe && (
                  <ToolTip
                    classProp="tooltip"
                    location="bottom"
                    description={getToolTipDescription(
                      store._preferences?.avatarVoiceLevels?.[person.profile.displayName]?.muted
                    )}
                  >
                    {store._preferences?.avatarVoiceLevels?.[person.profile.displayName]?.muted ? (
                      <UserSoundOffIcon />
                    ) : (
                      <UserSoundOnIcon />
                    )}
                  </ToolTip>
                )}
                {person.profile && person.profile.hidden && (
                  <span
                    className={styles.awayIcon}
                    title={intl.formatMessage({
                      id: "people-sidebar.not-looking-label",
                      defaultMessage: "Not looking at the room"
                    })}
                  >
                    {AWAY_GLYPH}
                  </span>
                )}
                <p className={styles.personName}>{getPersonName(person, intl)}</p>
                <AchievementBadges person={person} />
                <StatusLabel status={person.profile && person.profile.status} />
                {person.roles.owner && (
                  <StarIcon
                    title={intl.formatMessage({ id: "people-sidebar.moderator-label", defaultMessage: "Moderator" })}
                    className={styles.moderatorIcon}
                    width={12}
                    height={12}
                  />
                )}
                <p className={styles.presence}>{getPresenceMessage(person.presence, intl)}</p>
                {/* Only people actually in the room: a call is a data channel
                    message, and the lobby is not on that channel. Rendered as a
                    span rather than a button because the row is itself one. */}
                {onCallPerson && !person.isMe && person.presence === "room" && !person.context?.discord && (
                  <ToolTip
                    classProp="tooltip"
                    // Opens leftwards, into the panel: this button sits hard
                    // against the right edge, and the tooltip is anchored to the
                    // side it grows from — "bottom" grows right, off the screen.
                    location="left"
                    description={
                      callDisabled
                        ? intl.formatMessage(callRingingDescription)
                        : intl.formatMessage(callDescription, { name: person.profile.displayName })
                    }
                  >
                    <span
                      className={classNames(styles.callButton, { [styles.callButtonDisabled]: callDisabled })}
                      role="button"
                      aria-disabled={callDisabled}
                      tabIndex={callDisabled ? -1 : 0}
                      onClick={e => {
                        // The row opens the profile; this does not.
                        e.stopPropagation();
                        if (callDisabled) return;
                        onCallPerson(person);
                      }}
                      onKeyDown={e => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.stopPropagation();
                        e.preventDefault();
                        if (callDisabled) return;
                        onCallPerson(person);
                      }}
                    >
                      <CallIcon width={15} height={15} />
                    </span>
                  </ToolTip>
                )}
              </ButtonListItem>
            );
          })}
      </List>
    </Sidebar>
  );
}

PeopleSidebar.propTypes = {
  people: PropTypes.array,
  onSelectPerson: PropTypes.func,
  onCallPerson: PropTypes.func,
  callDisabled: PropTypes.bool,
  showMuteAll: PropTypes.bool,
  onMuteAll: PropTypes.func,
  onClose: PropTypes.func,
  canVoiceChat: PropTypes.bool,
  voiceChatEnabled: PropTypes.bool,
  isMod: PropTypes.bool
};

PeopleSidebar.defaultProps = {
  people: [],
  onSelectPerson: () => {},
  isMod: false
};
