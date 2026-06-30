// GraphQL query for a single item's customization/option groups on the second supported platform.
// This is a trimmed version of the document the store page itself sends to its per-item endpoint:
// only the item header and the option groups (with up to two levels of nested options) are kept,
// dropping the unrelated banner/review/carousel/badge fields. The platform's endpoint accepts the
// query inline (no persisted-query hash) and needs only the page's own cookies.
export const ITEM_OPTIONS_QUERY = `query itemPage($storeId: ID!, $itemId: ID!, $isNested: Boolean!, $fulfillmentType: FulfillmentType) {
  itemPage(storeId: $storeId, itemId: $itemId, fulfillmentType: $fulfillmentType) {
    itemHeader @skip(if: $isNested) {
      id
      name
      description
      displayString
      unitAmount
      currency
      decimalPlaces
      __typename
    }
    optionLists {
      ...OptionListFragment
      __typename
    }
    __typename
  }
}
fragment OptionListFragment on OptionList {
  type
  id
  name
  subtitle
  selectionNode
  minNumOptions
  maxNumOptions
  minOptionChoiceQuantity
  maxOptionChoiceQuantity
  minAggregateOptionsQuantity
  maxAggregateOptionsQuantity
  numFreeOptions
  isOptional
  options {
    ...OptionFragment
    nestedExtrasList {
      ...NestedExtrasFragment
      __typename
    }
    __typename
  }
  __typename
}
fragment OptionFragment on FeedOption {
  id
  name
  description
  unitAmount
  currency
  displayString
  decimalPlaces
  chargeAbove
  defaultQuantity
  minOptionChoiceQuantity
  maxOptionChoiceQuantity
  __typename
}
fragment NestedExtrasFragment on OptionList {
  type
  id
  name
  subtitle
  selectionNode
  minNumOptions
  maxNumOptions
  numFreeOptions
  isOptional
  options {
    ...OptionFragment
    nestedExtrasList {
      type
      id
      name
      minNumOptions
      maxNumOptions
      numFreeOptions
      isOptional
      options {
        ...OptionFragment
        __typename
      }
      __typename
    }
    __typename
  }
  __typename
}`;
