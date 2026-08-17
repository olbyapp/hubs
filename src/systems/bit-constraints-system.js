import { anyEntityWith, findAncestorEntity } from "../utils/bit-utils";
import { CONSTANTS } from "three-ammo";
const { DISABLE_DEACTIVATION, ACTIVE_TAG } = CONSTANTS.ACTIVATION_STATE;

import {
  addComponent,
  defineQuery,
  enterQuery,
  entityExists,
  removeComponent,
  exitQuery,
  hasComponent,
  Not
} from "bitecs";
import {
  RemoteRight,
  RemoteLeft,
  HandRight,
  HandLeft,
  HeldRemoteRight,
  HeldRemoteLeft,
  HeldHandRight,
  HeldHandLeft,
  OffersHandConstraint,
  OffersRemoteConstraint,
  Rigidbody,
  Constraint,
  ConstraintHandLeft,
  ConstraintHandRight,
  ConstraintRemoteLeft,
  ConstraintRemoteRight,
  SnapPlacing
} from "../bit-components";

// Not(SnapPlacing): объекты, которые ведёт placement-snap-system, держатся не
// физикой, а прямой записью трансформа. Упругий констрейнт спорил бы с ней за
// положение тела в том же кадре. Пометка ставится в hold-system до этой системы,
// поэтому такие сущности в запросы ниже вообще не попадают.
const queryRemoteRight = defineQuery([HeldRemoteRight, OffersRemoteConstraint, Not(SnapPlacing)]);
const queryEnterRemoteRight = enterQuery(queryRemoteRight);
const queryExitRemoteRight = exitQuery(queryRemoteRight);

const queryRemoteLeft = defineQuery([HeldRemoteLeft, OffersRemoteConstraint, Not(SnapPlacing)]);
const queryEnterRemoteLeft = enterQuery(queryRemoteLeft);
const queryExitRemoteLeft = exitQuery(queryRemoteLeft);

const queryHandRight = defineQuery([HeldHandRight, OffersHandConstraint, Not(SnapPlacing)]);
const queryEnterHandRight = enterQuery(queryHandRight);
const queryExitHandRight = exitQuery(queryHandRight);

const queryHandLeft = defineQuery([HeldHandLeft, OffersHandConstraint, Not(SnapPlacing)]);
const queryEnterHandLeft = enterQuery(queryHandLeft);
const queryExitHandLeft = exitQuery(queryHandLeft);

const grabBodyOptions = { type: "dynamic", activationState: DISABLE_DEACTIVATION };
const releaseBodyOptions = { activationState: ACTIVE_TAG };

function add(world, physicsSystem, interactor, constraintComponent, entities) {
  for (let i = 0; i < entities.length; i++) {
    const eid = findAncestorEntity(world, entities[i], ancestor => hasComponent(world, Rigidbody, ancestor));
    if (!entityExists(world, eid)) continue;
    physicsSystem.updateRigidBodyOptions(eid, grabBodyOptions);
    physicsSystem.addConstraint(interactor, Rigidbody.bodyId[eid], Rigidbody.bodyId[interactor], {});
    addComponent(world, Constraint, eid);
    addComponent(world, constraintComponent, eid);
  }
}

function remove(world, offersConstraint, constraintComponent, physicsSystem, interactor, entities) {
  for (let i = 0; i < entities.length; i++) {
    const eid = findAncestorEntity(world, entities[i], ancestor => hasComponent(world, Rigidbody, ancestor));
    if (!entityExists(world, eid)) continue;
    if (hasComponent(world, offersConstraint, entities[i]) && hasComponent(world, Rigidbody, eid)) {
      physicsSystem.updateRigidBodyOptions(eid, releaseBodyOptions);
      physicsSystem.removeConstraint(interactor);
      removeComponent(world, constraintComponent, eid);
      if (
        !hasComponent(world, ConstraintHandLeft, eid) &&
        !hasComponent(world, ConstraintHandRight, eid) &&
        !hasComponent(world, ConstraintRemoteLeft, eid) &&
        !hasComponent(world, ConstraintRemoteRight, eid)
      ) {
        removeComponent(world, Constraint, eid);
      }
    }
  }
}

export function constraintsSystem(world, physicsSystem) {
  add(world, physicsSystem, anyEntityWith(world, RemoteRight), ConstraintRemoteRight, queryEnterRemoteRight(world));
  add(world, physicsSystem, anyEntityWith(world, RemoteLeft), ConstraintRemoteLeft, queryEnterRemoteLeft(world));
  add(world, physicsSystem, anyEntityWith(world, HandRight), ConstraintHandRight, queryEnterHandRight(world));
  add(world, physicsSystem, anyEntityWith(world, HandLeft), ConstraintHandLeft, queryEnterHandLeft(world));
  remove(
    world,
    OffersRemoteConstraint,
    ConstraintRemoteRight,
    physicsSystem,
    anyEntityWith(world, RemoteRight),
    queryExitRemoteRight(world)
  );
  remove(
    world,
    OffersRemoteConstraint,
    ConstraintRemoteLeft,
    physicsSystem,
    anyEntityWith(world, RemoteLeft),
    queryExitRemoteLeft(world)
  );
  remove(
    world,
    OffersHandConstraint,
    ConstraintHandRight,
    physicsSystem,
    anyEntityWith(world, HandRight),
    queryExitHandRight(world)
  );
  remove(
    world,
    OffersHandConstraint,
    ConstraintHandRight,
    physicsSystem,
    anyEntityWith(world, HandLeft),
    queryExitHandLeft(world)
  );
}
