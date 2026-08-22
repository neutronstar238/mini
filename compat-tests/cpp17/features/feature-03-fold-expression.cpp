#include <iostream>
template<class... T> int sum(T... v){ return (v+...); }
int main(){ std::cout<<sum(1,2,3,4)<<"\n"; }
