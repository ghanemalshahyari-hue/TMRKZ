package ae.mover.stationing;

/**
 * What a stage's decision rests on (V2 D18, kept by Model V3): after a return for changes only the decisions resting on
 * a changed fact are taken again.
 */
public enum Fact {
    SCOPE, CLASSIFICATION, DURATION, SITE, DEPLOYMENT, AVAILABILITY
}
